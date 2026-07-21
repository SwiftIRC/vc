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

// Link this third-party module against OpenSSL (HMAC-SHA256 for token signing) and
// libcurl (provision POST). Anope's build reads this inline-CMake block from the
// source; idiom copied from modules/extra/ssl_openssl.cpp and modules/extra/sqlite.cpp.
// VERIFY(anope-2.1): inline `/// BEGIN CMAKE` link mechanism — modules/CMakeLists.txt
// (inline_cmake/build_module) and modules/extra/ssl_openssl.cpp.
/// BEGIN CMAKE
/// find_package("OpenSSL" REQUIRED)
/// find_package("CURL" REQUIRED)
/// target_link_libraries(${SO} PRIVATE OpenSSL::Crypto CURL::libcurl)
/// END CMAKE

// The deployment build links libcurl, so enable core/provision.h's postProvision().
// core/provision.h itself includes <curl/curl.h> at *global* scope (guarded by
// WVC_HAVE_CURL, above its `namespace wvc`), so curl's symbols land in the global
// namespace where they belong — no pre-include is needed here (fixed in provision.h
// commit 1b4123a; this file used to belt-and-suspenders `#include <curl/curl.h>` too).
#define WVC_HAVE_CURL

#include "module.h"

#include "core/build.h"      // wvc::Role, wvc::roleString, wvc::makeClaims
#include "core/token.h"      // wvc::sign
#include "core/provision.h"  // wvc::buildProvisionBody, wvc::postProvision
#include "core/invite.h"      // wvc::randomId, wvc::buildInviteBody, wvc::postInvite

namespace
{
	// Parse ON/OFF (case-insensitive) into `out`. Returns false on anything else.
	bool ParseOnOff(const Anope::string &value, bool &out)
	{
		if (value.equals_ci("ON"))
		{
			out = true;
			return true;
		}
		if (value.equals_ci("OFF"))
		{
			out = false;
			return true;
		}
		return false;
	}
}

class WebRTCChat;

// The `VC` command: `/msg ChanServ VC #chan [SET {ENABLED|IDENTIFIED|ROOM} value]`
// and, when wired as a fantasy command in anope.conf, `!vc` / `!chat` in-channel.
// Method bodies are defined out-of-line below, after WebRTCChat is complete, so the
// command can call the module's public API.
class CommandVC final
	: public Command
{
private:
	WebRTCChat *module;

public:
	CommandVC(Module *creator, WebRTCChat *mod);
	void Execute(CommandSource &source, const std::vector<Anope::string> &params) override;
	bool OnHelp(CommandSource &source, const Anope::string &subcommand) override;
};

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

	// The VC command service. Registering it here creates the "chanserv/vc"
	// Command service; anope.conf wires it to ChanServ and to the !vc/!chat
	// fantasy triggers (see anope.conf.example).
	CommandVC commandvc;

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
		, commandvc(this, this)
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

	// The effective slug: explicit setting, else the (deduplicated) default derived
	// from the channel name. Distinct channels can normalize to the same DefaultSlug
	// (#c, #c++, #c# all -> "c"); handing both the same slug would silently merge two
	// channels' video rooms. To keep default slugs UNIQUE and STABLE, the
	// earliest-registered channel that wants a given default keeps it, and every later
	// collider gets a deterministic per-name suffix — so the link !vc posts today still
	// works next month, and a channel that registers later never steals an earlier
	// channel's already-handed-out slug. (Colliding names can pick a clean slug with
	// `VC #chan SET ROOM <name>`.)
	Anope::string RoomFor(const ChannelInfo *ci) const
	{
		const Anope::string *r = this->room.Get(ci);
		if (r && !r->empty())
			return *r;

		const Anope::string d = this->DefaultSlug(ci->name);

		// Does any *earlier* channel also want `d`? Compare against each other
		// channel's raw effective slug (explicit room, else its DefaultSlug) — never
		// recursing through RoomFor, which would recurse straight back into this scan.
		// Ties on the registration second break by channel name so exactly one channel
		// owns the clean slug. ChannelInfo::registered is the time_t registration time
		// (Anope 2.1; it was named time_registered in 2.0). ChannelInfo::name is the
		// registered_channel_map key.
		for (const auto &pair : *RegisteredChannelList)
		{
			const ChannelInfo *other = pair.second;
			if (!other || other == ci || other->name.equals_ci(ci->name))
				continue;
			const Anope::string *ro = this->room.Get(other);
			const Anope::string other_wants = (ro && !ro->empty()) ? *ro : this->DefaultSlug(other->name);
			if (!other_wants.equals_ci(d))
				continue;
			const bool other_is_earlier =
				other->registered < ci->registered
				|| (other->registered == ci->registered
					&& other->name.str() < ci->name.str());
			if (other_is_earlier)
				return d + "-" + WebRTCChat::NameHash(ci->name);
		}
		return d;
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

	// Short lowercase-hex FNV-1a hash of a channel name — the deterministic per-name
	// suffix that disambiguates default-slug collisions (see RoomFor). Deterministic
	// across restarts, so a suffixed default slug stays stable; the "-" + [0-9a-f]
	// tail keeps the combined slug within slugRe (^[a-z0-9][a-z0-9-]*$).
	static Anope::string NameHash(const Anope::string &name)
	{
		unsigned long long h = 1469598103934665603ULL; // FNV-1a offset basis
		for (size_t i = 0; i < name.length(); ++i)
		{
			h ^= static_cast<unsigned char>(name[i]);
			h *= 1099511628211ULL;
		}
		static const char digits[] = "0123456789abcdef";
		const unsigned long v = static_cast<unsigned long>(h & 0xffffffffULL);
		Anope::string out;
		for (int shift = 28; shift >= 0; shift -= 4)
			out += digits[(v >> shift) & 0xf];
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

	// True if `slug` is already claimed by a channel other than exceptChannel — as its
	// explicit room OR its effective default slug. It compares against RoomFor(other),
	// so the deduplicated (possibly suffixed) default a channel actually resolves to is
	// what's checked; SET ROOM therefore can't claim another channel's clean *or*
	// suffixed default. Computed by a live scan of the registered-channel list so it
	// stays correct across restarts without a separately-maintained cache (structural
	// note: replaces the plan's rebuilt-on-load std::map<slug,channel> with an on-demand
	// scan; SET ROOM is rare so the cost — O(channels^2) now that RoomFor runs its own
	// dedup scan per channel — is irrelevant).
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

	// ---- join: link + token + provision (shared helper) -------------------

	// Map the caller's channel access to a token role.
	// VERIFY(anope-2.1): AccessGroup::founder field and HasPriv priv names — "SET"
	// and "AUTOOP" are used in modules/chanserv/cs_set.cpp; "AUTOVOICE" is the
	// standard voice-grant privilege (include/access.h; confirm against the
	// privileges registered in modules/chanserv/cs_access.cpp / the deployment tree).
	wvc::Role RoleFor(CommandSource &source, ChannelInfo *ci)
	{
		AccessGroup access = source.AccessFor(ci);
		if (access.founder || access.HasPriv("AUTOOP") || access.HasPriv("SET"))
			return wvc::Role::Op;
		if (access.HasPriv("AUTOVOICE"))
			return wvc::Role::Voice;
		return wvc::Role::User;
	}

	// Shared by !vc/!chat (fantasy) and `VC #chan` (no SET). Posts the public link,
	// hands identified users a tokened personal link, and provisions the room.
	// The shared secret and full tokens are NEVER logged or replied — the only place
	// a token appears is the private NOTICE to that token's own recipient.
	void HandleJoin(CommandSource &source, ChannelInfo *ci)
	{
		if (!this->IsEnabled(ci))
		{
			source.Reply(_("Video chat isn't enabled here \342\200\224 an op can run \002/msg ChanServ VC %s SET ENABLED ON\002."),
				ci->name.c_str());
			return;
		}

		const Anope::string slug = this->RoomFor(ci);
		const bool id_only = this->IsIdentifiedOnly(ci);
		const Anope::string public_url = this->linkorigin + "/" + slug;

		BotInfo *bi = source.service;
		User *u = source.GetUser();

		// Public link (no token). To the channel via fantasy so everyone sees it,
		// otherwise privately to the caller.
		// VERIFY(anope-2.1): CommandSource::c (fantasy channel, Reference<Channel>) and
		// CommandSource::service (Reference<BotInfo>) — include/commands.h:70,72 and
		// modules/fantasy.cpp:199-200; IRCD->SendPrivmsg(MessageSource, dest, msg) with a
		// BotInfo* (is-a User) as the MessageSource — include/protocol.h:48,344.
		if (source.c && bi)
			IRCD->SendPrivmsg(bi, source.c->name, Anope::string(_("Video chat: ")) + public_url);
		else
			source.Reply(_("Video chat for %s: %s"), ci->name.c_str(), public_url.c_str());

		// Personal tokened link for users identified to NickServ.
		// VERIFY(anope-2.1): CommandSource::GetAccount()/GetUser()/GetNick() —
		// include/commands.h:83-85; NickCore::display (account name) — include/account.h:150;
		// User::SendMessage(BotInfo*, const Anope::string&) private NOTICE —
		// include/users.h:202; Anope::CurTime (time_t) — include/anope.h:381.
		// Best-effort server call, time-bounded so services never block on a down
		// webrtc-chat. `err` is a curl/HTTP status string and never carries the secret.
		std::string err;
		bool reachable = true;

		NickCore *nc = source.GetAccount();
		if (nc && u && bi)
		{
			// Identified: mint a token, register it under a short random id, and hand
			// out the compact link (origin/slug#i=<id>) so it never wraps/truncates in
			// IRC. Registering also provisions the room from the token's claims. If the
			// server is unreachable, fall back to the self-contained long token link
			// (#t=<token>), which re-provisions the room on a tokened join.
			wvc::Role role = this->RoleFor(source, ci);
			wvc::Claims claims = wvc::makeClaims(
				ci->name.str(), slug.str(), nc->display.str(), source.GetNick().str(),
				role, id_only,
				static_cast<long long>(Anope::CurTime), static_cast<long long>(this->ttl));
			std::string token = wvc::sign(claims, this->secret.str());
			std::string id = wvc::randomId();
			Anope::string personal_url;
			if (!id.empty() && wvc::postInvite(this->apiurl.str(), this->secret.str(), id, token, /*timeoutMs=*/2000, err))
				personal_url = this->linkorigin + "/" + slug + "#i=" + id;
			else
			{
				reachable = false;
				personal_url = this->linkorigin + "/" + slug + "#t=" + token;
			}
			u->SendMessage(bi, Anope::string(_("Your personal video chat link (opens with your channel role): ")) + personal_url);
		}
		else if (u && bi)
		{
			// Guest invoker: no personal link, but still provision the room so the
			// public link works for everyone.
			std::string body = wvc::buildProvisionBody(ci->name.str(), slug.str(), id_only);
			if (!wvc::postProvision(this->apiurl.str(), this->secret.str(), body, /*timeoutMs=*/2000, err))
				reachable = false;
			if (id_only)
				u->SendMessage(bi, _("This room only admits users identified to NickServ \342\200\224 identify, then try again."));
			else
				u->SendMessage(bi, _("Identify to NickServ for a personal (op) link; the public link works for guests."));
		}

		// VERIFY(anope-2.1): Log(LOG_DEBUG) << ... streaming logger — include/logger.h and
		// modules/fantasy.cpp:170.
		if (!reachable)
		{
			Log(LOG_DEBUG) << "webrtc_chat: server unreachable for " << ci->name << ": " << err;
			if (u && bi)
				u->SendMessage(bi, _("Room link posted, but the video server is unreachable right now."));
		}
	}
};

// VERIFY(anope-2.1): Command(Module*, sname, min_params, max_params); SetDesc,
// SetSyntax, AllowUnregistered are Command methods — include/commands.h:133,139,142,145
// and modules/fantasy.cpp:21-25.
CommandVC::CommandVC(Module *creator, WebRTCChat *mod)
	: Command(creator, "chanserv/vc", 1, 4)
	, module(mod)
{
	this->SetDesc(_("Get or configure the video chat room for a channel"));
	this->SetSyntax(_("\037#channel\037 [\002SET\002 {\002ENABLED\002 | \002IDENTIFIED\002 | \002ROOM\002} \037value\037]"));
	// Guests (not identified to NickServ) may still run !vc / VC to get the public
	// link; without this the fantasy dispatcher drops unidentified callers
	// (modules/fantasy.cpp:188). Settings changes are separately gated on channel
	// access, which requires an account anyway.
	// VERIFY(anope-2.1): AllowUnregistered(bool) semantics — include/commands.h:145.
	this->AllowUnregistered(true);
}

void CommandVC::Execute(CommandSource &source, const std::vector<Anope::string> &params)
{
	// params[0] is always the channel: supplied directly for /msg ChanServ VC #chan,
	// or prepended by the fantasy dispatcher when prepend_channel is set for !vc/!chat.
	// VERIFY(anope-2.1): ChannelInfo::Find + CHAN_X_NOT_REGISTERED language string —
	// include/regchannel.h:192 and modules/fantasy.cpp:29,34.
	ChannelInfo *ci = ChannelInfo::Find(params[0]);
	if (!ci)
	{
		source.Reply(CHAN_X_NOT_REGISTERED, params[0].c_str());
		return;
	}

	// ---- VC #chan SET <opt> <value> : op/founder-gated settings ----------
	if (params.size() >= 2 && params[1].equals_ci("SET"))
	{
		// VERIFY(anope-2.1): AccessGroup AccessFor(ci).HasPriv("SET") for op/founder,
		// source.HasPriv("chanserv/administration") for services opers, ACCESS_DENIED
		// language string — include/access.h:151,171, include/commands.h:86,99 and
		// modules/fantasy.cpp:38-41. "SET" is the standard ChanServ SET privilege
		// (modules/chanserv/cs_set.cpp).
		if (!source.AccessFor(ci).HasPriv("SET") && !source.HasPriv("chanserv/administration"))
		{
			source.Reply(ACCESS_DENIED);
			return;
		}
		// VERIFY(anope-2.1): Anope::ReadOnly global + READ_ONLY_MODE language string —
		// include/anope.h:390 and modules/fantasy.cpp:44-46.
		if (Anope::ReadOnly)
		{
			source.Reply(READ_ONLY_MODE);
			return;
		}
		if (params.size() < 4)
		{
			this->OnSyntaxError(source, "SET");
			return;
		}

		const Anope::string &opt = params[2];
		const Anope::string &value = params[3];
		bool is_override = !source.AccessFor(ci).HasPriv("SET");

		if (opt.equals_ci("ENABLED"))
		{
			bool on;
			if (!ParseOnOff(value, on))
			{
				this->OnSyntaxError(source, "SET");
				return;
			}
			module->SetEnabled(ci, on);
			// VERIFY(anope-2.1): Log(level, source, command, ci) << msg streaming API +
			// LOG_COMMAND/LOG_OVERRIDE — include/logger.h and modules/fantasy.cpp:53.
			Log(is_override ? LOG_OVERRIDE : LOG_COMMAND, source, this, ci)
				<< "to " << (on ? "enable" : "disable") << " video chat";
			source.Reply(on
				? _("Video chat is now \002enabled\002 on %s.")
				: _("Video chat is now \002disabled\002 on %s."),
				ci->name.c_str());
		}
		else if (opt.equals_ci("IDENTIFIED"))
		{
			bool on;
			if (!ParseOnOff(value, on))
			{
				this->OnSyntaxError(source, "SET");
				return;
			}
			module->SetIdentifiedOnly(ci, on);
			Log(is_override ? LOG_OVERRIDE : LOG_COMMAND, source, this, ci)
				<< "to set identified-only to " << (on ? "on" : "off");
			source.Reply(on
				? _("Video chat on %s now requires users to be identified to NickServ.")
				: _("Video chat on %s now allows guests."),
				ci->name.c_str());
		}
		else if (opt.equals_ci("ROOM"))
		{
			Anope::string slug = value.lower();
			if (!WebRTCChat::ValidSlug(slug))
			{
				source.Reply(_("\002%s\002 is not a valid room name. Use lowercase letters, digits and hyphens, starting with a letter or digit."),
					value.c_str());
				return;
			}
			if (module->SlugTaken(slug, ci->name))
			{
				source.Reply(_("That room name is taken by another channel."));
				return;
			}
			module->SetRoom(ci, slug);
			Log(is_override ? LOG_OVERRIDE : LOG_COMMAND, source, this, ci)
				<< "to set room to " << slug;
			source.Reply(_("Video chat room for %s is now \002%s\002 (%s/%s)."),
				ci->name.c_str(), slug.c_str(), module->LinkOrigin().c_str(), slug.c_str());
		}
		else
		{
			this->OnSyntaxError(source, "SET");
		}
		return;
	}

	// ---- VC #chan (no SET), and !vc / !chat via fantasy : join ----------
	// Both the fantasy triggers and the plain command land here (the fantasy
	// dispatcher routes !vc/!chat to this same command service — see
	// modules/fantasy.cpp:150-231 and anope.conf.example), so botless channels work
	// via /msg and the shared HandleJoin runs exactly once per invocation.
	// VERIFY(anope-2.1): fantasy dispatch routes a registered fantasy command to its
	// Command service's Execute with source.c set — modules/fantasy.cpp:199-228.
	module->HandleJoin(source, ci);
}

bool CommandVC::OnHelp(CommandSource &source, const Anope::string &)
{
	this->SendSyntax(source);
	source.Reply(" ");
	source.Reply(_(
		"Hands out the video chat room link for a channel and, for users "
		"identified to NickServ, a personal link that joins with their channel "
		"role. Used in-channel as \002!vc\002 or \002!chat\002, or as "
		"\002/msg ChanServ VC \037#channel\037\002.\n"
		" \n"
		"Channel operators can configure the room:\n"
		"\002SET\002 \037#channel\037 \002ENABLED\002 {\002ON\002 | \002OFF\002}      Turn video chat on or off.\n"
		"\002SET\002 \037#channel\037 \002IDENTIFIED\002 {\002ON\002 | \002OFF\002}   Restrict joining to identified users.\n"
		"\002SET\002 \037#channel\037 \002ROOM\002 \037name\037           Set the room slug (lowercase, a-z 0-9 -)."));
	return true;
}

MODULE_INIT(WebRTCChat)
