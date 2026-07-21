// m_webrtc_chat — SwiftIRC Anope 2.1 services module.
//
// Binds IRC channels to webrtc-chat rooms: `!vc`/`!chat` (and `/msg ChanServ VC
// #chan`) hand out room links, `VC #chan SET ...` stores per-channel settings,
// identified users get an HMAC token, and every join request provisions the room
// over HTTP.
//
// The token/provision logic lives in the pure, host-tested core under core/
// (namespace wvc); this translation unit is the Anope glue. There is no Anope SDK
// on the development host, so this file is written to the documented Anope 2.1 API
// and compiled in the SwiftIRC deployment tree. Every call whose exact signature
// was confirmed against the 2.1 headers carries a `// VERIFY(anope-2.1):` marker
// naming the header / example module the reviewer should re-check.
//
// SPDX-License-Identifier: GPL-2.0-only

// The deployment build links libcurl, so enable core/provision.h's postProvision().
// NOTE: core/provision.h does `#include <curl/curl.h>` *inside* `namespace wvc`.
// Including curl at global scope first means that in-namespace include is a no-op
// (curl/curl.h has its own include guard), keeping curl's symbols in the global
// namespace where they belong. Do not remove this pre-include.
#define WVC_HAVE_CURL
#include <curl/curl.h>

#include "module.h"

#include "core/build.h"      // wvc::Role, wvc::roleString, wvc::makeClaims
#include "core/token.h"      // wvc::sign
#include "core/provision.h"  // wvc::buildProvisionBody, wvc::postProvision

class WebRTCChat final
	: public Module
{
private:
	// Per-channel settings, persisted with the channel's registration.
	// SerializableExtensibleItem<bool> presence == "on"; the string item stores
	// the room slug. Precedent: modules/fantasy.cpp uses
	// `SerializableExtensibleItem<bool> fantasy(this, "BS_FANTASY")`.
	// VERIFY(anope-2.1): SerializableExtensibleItem<T> Set/Unset/Get/HasExt +
	// automatic per-channel persistence — include/extensible.h (BaseExtensibleItem,
	// SerializableExtensibleItem) and modules/fantasy.cpp:93,100,117.
	SerializableExtensibleItem<bool> enabled;
	SerializableExtensibleItem<bool> identifiedonly;
	SerializableExtensibleItem<Anope::string> room;

	// Config (module block in anope.conf), refreshed in OnReload.
	Anope::string secret;      // shared HMAC secret == webrtc-chat's -secret. NEVER logged/replied.
	Anope::string apiurl;      // provision POST target, e.g. http://127.0.0.1:8080
	Anope::string linkorigin;  // public link origin, e.g. https://vc.swiftirc.net
	time_t ttl;                // token lifetime (seconds)

public:
	// VERIFY(anope-2.1): Module(const Anope::string&, const Anope::string&, ModType)
	// 3-arg ctor with the module type passed positionally (THIRD for third-party) —
	// include/modules.h:252 and modules/fantasy.cpp:98-99 (which passes VENDOR).
	WebRTCChat(const Anope::string &modname, const Anope::string &creator)
		: Module(modname, creator, THIRD)
		, enabled(this, "webrtc_enabled")
		, identifiedonly(this, "webrtc_identifiedonly")
		, room(this, "webrtc_room")
		, ttl(600)
	{
		// VERIFY(anope-2.1): SetAuthor/SetVersion are Module methods —
		// include/modules.h:275,280.
		this->SetAuthor("SwiftIRC");
		this->SetVersion("1.0");
	}

	// VERIFY(anope-2.1): OnReload takes `Configuration::Conf &` (reference, not
	// pointer) in 2.1 — include/modules.h:313 and modules/fantasy.cpp:105.
	// VERIFY(anope-2.1): OnReload fires on initial config load as well as rehash so
	// these members are populated before the first command runs.
	void OnReload(Configuration::Conf &conf) override
	{
		// VERIFY(anope-2.1): conf.GetModule(this) returns Configuration::Block& and
		// Block::Get<const Anope::string>/<time_t> with a string default —
		// include/config.h:51,60-61,134 and modules/fantasy.cpp:107-108.
		const auto &block = conf.GetModule(this);
		this->secret     = block.Get<const Anope::string>("secret");
		this->apiurl     = block.Get<const Anope::string>("apiurl", "http://127.0.0.1:8080");
		this->linkorigin = block.Get<const Anope::string>("linkorigin");
		this->ttl        = block.Get<time_t>("ttl", "600");
		if (this->ttl <= 0)
			this->ttl = 600;
	}

	// ---- config accessors -------------------------------------------------

	const Anope::string &Secret() const { return this->secret; }
	const Anope::string &ApiUrl() const { return this->apiurl; }
	const Anope::string &LinkOrigin() const { return this->linkorigin; }
	time_t Ttl() const { return this->ttl; }

	// ---- per-channel settings --------------------------------------------

	bool IsEnabled(const ChannelInfo *ci) const { return this->enabled.HasExt(ci); }
	bool IsIdentifiedOnly(const ChannelInfo *ci) const { return this->identifiedonly.HasExt(ci); }

	void SetEnabled(ChannelInfo *ci, bool on)
	{
		if (on)
			this->enabled.Set(ci);
		else
			this->enabled.Unset(ci);
	}

	void SetIdentifiedOnly(ChannelInfo *ci, bool on)
	{
		if (on)
			this->identifiedonly.Set(ci);
		else
			this->identifiedonly.Unset(ci);
	}

	// The explicitly-configured slug, or "" if none is set.
	Anope::string RawRoom(const ChannelInfo *ci) const
	{
		const Anope::string *r = this->room.Get(ci);
		return r ? *r : Anope::string("");
	}

	// The effective slug: explicit setting, else derived from the channel name.
	Anope::string RoomFor(const ChannelInfo *ci) const
	{
		const Anope::string *r = this->room.Get(ci);
		if (r && !r->empty())
			return *r;
		return this->DefaultSlug(ci->name);
	}

	void SetRoom(ChannelInfo *ci, const Anope::string &slug) { this->room.Set(ci, slug); }

	// ---- slug registry ----------------------------------------------------

	// Derive a slug from a channel name: drop leading '#', lowercase, map any
	// char outside [a-z0-9-] to '-', collapse repeats, trim leading/trailing '-'.
	// Falls back to a channel-hash suffix if nothing usable remains. Result always
	// satisfies the server's slugRe (^[a-z0-9][a-z0-9-]*$).
	Anope::string DefaultSlug(const Anope::string &channel) const
	{
		// VERIFY(anope-2.1): Anope::string::lower() and operator[] — include/anope.h:126,275.
		Anope::string src = channel.lower();
		Anope::string out;
		bool last_dash = false;
		for (size_t i = 0; i < src.length(); ++i)
		{
			char c = src[i];
			if (c == '#')
				continue;
			if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))
			{
				out += c;
				last_dash = false;
			}
			else if (!out.empty() && !last_dash)
			{
				out += '-';
				last_dash = true;
			}
		}
		while (!out.empty() && out[out.length() - 1] == '-')
			out.erase(out.length() - 1);

		if (out.empty())
		{
			unsigned long long h = 1469598103934665603ULL; // FNV-1a over the raw channel name
			for (size_t i = 0; i < channel.length(); ++i)
			{
				h ^= static_cast<unsigned char>(channel[i]);
				h *= 1099511628211ULL;
			}
			out = "room" + Anope::string(std::to_string(h % 1000000ULL));
		}
		return out;
	}

	// slugRe parity: ^[a-z0-9][a-z0-9-]*$ (already-lowercased input expected).
	static bool ValidSlug(const Anope::string &s)
	{
		if (s.empty())
			return false;
		char f = s[0];
		if (!((f >= 'a' && f <= 'z') || (f >= '0' && f <= '9')))
			return false;
		for (size_t i = 0; i < s.length(); ++i)
		{
			char c = s[i];
			if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-'))
				return false;
		}
		return true;
	}

	// True if `slug` is already claimed by a channel other than exceptChannel —
	// either as an explicit room OR as another channel's default slug. Computed by
	// a live scan of the registered-channel list so it stays correct across
	// restarts without a separately-maintained cache (structural note: replaces the
	// plan's rebuilt-on-load std::map<slug,channel> with an on-demand scan; SET ROOM
	// is rare so the O(channels) cost is irrelevant).
	// VERIFY(anope-2.1): RegisteredChannelList is
	// Serialize::Checker<registered_channel_map>; `*RegisteredChannelList` yields the
	// Anope::unordered_map<ChannelInfo*> to iterate — include/regchannel.h:25,27 and
	// include/serialize.h (Checker::operator*).
	bool SlugTaken(const Anope::string &slug, const Anope::string &exceptChannel)
	{
		for (const auto &pair : *RegisteredChannelList)
		{
			ChannelInfo *other = pair.second;
			if (!other || other->name.equals_ci(exceptChannel))
				continue;
			Anope::string other_slug = this->RoomFor(other);
			if (other_slug.equals_ci(slug))
				return true;
		}
		return false;
	}
};

MODULE_INIT(WebRTCChat)
