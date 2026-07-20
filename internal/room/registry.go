package room

import (
	"errors"
	"sync"
	"time"

	"github.com/ryanwohara/webrtc-chat/internal/token"
)

const GCGrace = 60 * time.Second

var ErrNotProvisioned = errors.New("registry: room not provisioned")

type meta struct {
	channel        string
	identifiedOnly bool
}

type Registry struct {
	mu           sync.Mutex
	adhocAllowed bool
	now          func() time.Time
	rooms        map[string]*Room
	metas        map[string]meta
}

func NewRegistry(adhocAllowed bool, now func() time.Time) *Registry {
	if now == nil {
		now = time.Now
	}
	return &Registry{
		adhocAllowed: adhocAllowed,
		now:          now,
		rooms:        map[string]*Room{},
		metas:        map[string]meta{},
	}
}

// Provision records (or refreshes) a channel→room binding pushed by the
// Anope module, and applies setting changes to a live room instance.
func (g *Registry) Provision(channel, slug string, identifiedOnly bool) {
	g.mu.Lock()
	g.metas[slug] = meta{channel: channel, identifiedOnly: identifiedOnly}
	r := g.rooms[slug]
	g.mu.Unlock()
	if r != nil {
		r.SetIdentifiedOnly(identifiedOnly)
	}
}

func (g *Registry) Resolve(slug string, claims *token.Claims) (*Room, error) {
	if claims != nil && claims.Room == slug {
		g.Provision(claims.Channel, slug, claims.Flags&token.FlagIdentifiedOnly != 0)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if r, ok := g.rooms[slug]; ok {
		return r, nil
	}
	if m, ok := g.metas[slug]; ok {
		r := New(Config{Slug: slug, Channel: m.channel, IdentifiedOnly: m.identifiedOnly, Now: g.now})
		g.rooms[slug] = r
		return r, nil
	}
	if !g.adhocAllowed {
		return nil, ErrNotProvisioned
	}
	r := New(Config{Slug: slug, Adhoc: true, Now: g.now})
	g.rooms[slug] = r
	return r, nil
}

func (g *Registry) Peek(slug string) (count int, locked bool) {
	g.mu.Lock()
	r := g.rooms[slug]
	g.mu.Unlock()
	if r == nil {
		return 0, false
	}
	return r.Count(), r.Locked()
}

// Sweep deletes room instances empty for longer than GCGrace. Channel metas
// are never swept — the binding is permanent until process restart (and is
// refreshed by any !vc or tokened join anyway).
func (g *Registry) Sweep() {
	cutoff := g.now().Add(-GCGrace)
	g.mu.Lock()
	defer g.mu.Unlock()
	for slug, r := range g.rooms {
		if since, empty := r.EmptySince(); empty && since.Before(cutoff) {
			delete(g.rooms, slug)
		}
	}
}

func (g *Registry) Rooms() []*Room {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]*Room, 0, len(g.rooms))
	for _, r := range g.rooms {
		out = append(out, r)
	}
	return out
}
