// Package config holds process configuration for coyote.
package config

import (
	"flag"
	"fmt"
	"io"
	"log/slog"
	"strconv"
)

type Config struct {
	Addr       string // HTTP listen address
	PublicIP   string // advertised ICE address (used by the media plane in Plan 2)
	UDPPortMin int    // media port range (Plan 2)
	UDPPortMax int
	Secret     string // shared HMAC secret; empty disables channel-room features
	AdhocRooms bool   // allow non-IRC rooms created by first join
	TLSCert    string // optional built-in TLS
	TLSKey     string
	TrustProxy bool // trust X-Forwarded-For (only enable behind a trusted reverse proxy)
	// Minimum level the process logs at. The media plane reports per-peer signaling
	// failures — an offer or answer that would not apply, a candidate rejected — at
	// debug, because they are per-frame chatter on a healthy server and a flood on a
	// flapping one. They are also the only evidence of a peer whose forwards are
	// announced but never bound, which presents as a participant nobody can see or
	// hear while everything else looks connected. Without a way to raise the level in
	// place, diagnosing that costs a redeploy.
	LogLevel slog.Level
}

// Load parses configuration: flags (highest precedence), then env via
// getenv (WVC_*), then defaults. getenv is injected for testability.
func Load(args []string, getenv func(string) string) (Config, error) {
	str := func(key, fallback string) string {
		if v := getenv(key); v != "" {
			return v
		}
		return fallback
	}
	boolean := func(key string, fallback bool) bool {
		if v := getenv(key); v != "" {
			b, err := strconv.ParseBool(v)
			if err == nil {
				return b
			}
		}
		return fallback
	}
	integer := func(key string, fallback int) int {
		if v := getenv(key); v != "" {
			n, err := strconv.Atoi(v)
			if err == nil {
				return n
			}
		}
		return fallback
	}

	fs := flag.NewFlagSet("coyote", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var cfg Config
	fs.StringVar(&cfg.Addr, "addr", str("WVC_ADDR", ":8080"), "HTTP listen address")
	fs.StringVar(&cfg.PublicIP, "public-ip", str("WVC_PUBLIC_IP", ""), "advertised ICE address")
	fs.IntVar(&cfg.UDPPortMin, "udp-min", integer("WVC_UDP_MIN", 50000), "media UDP port range start")
	fs.IntVar(&cfg.UDPPortMax, "udp-max", integer("WVC_UDP_MAX", 50199), "media UDP port range end")
	fs.StringVar(&cfg.Secret, "secret", str("WVC_SECRET", ""), "shared HMAC secret for tokens and provisioning")
	fs.BoolVar(&cfg.AdhocRooms, "adhoc", boolean("WVC_ADHOC", true), "allow ad-hoc (non-IRC) rooms")
	fs.StringVar(&cfg.TLSCert, "tls-cert", str("WVC_TLS_CERT", ""), "TLS certificate file (optional)")
	fs.StringVar(&cfg.TLSKey, "tls-key", str("WVC_TLS_KEY", ""), "TLS key file (optional)")
	fs.BoolVar(&cfg.TrustProxy, "trust-proxy", boolean("WVC_TRUST_PROXY", false), "trust X-Forwarded-For (enable only behind a trusted reverse proxy)")
	logLevel := fs.String("log-level", str("WVC_LOG_LEVEL", "info"), "log verbosity: debug, info, warn, error")
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	// slog.Level.UnmarshalText accepts the names case-insensitively (and offsets like
	// "debug+2"), so it is both the idiomatic parse and a slightly richer one.
	//
	// An unparseable value is an ERROR, not a fall back to the default. This setting
	// exists to be turned up mid-incident, and a typo that silently left the level at
	// info would read as "those code paths never fire" — sending the reader off to
	// look for a bug in the wrong place, which is the exact failure it is meant to end.
	if err := cfg.LogLevel.UnmarshalText([]byte(*logLevel)); err != nil {
		return Config{}, fmt.Errorf("log-level %q: %w", *logLevel, err)
	}
	if cfg.UDPPortMin > cfg.UDPPortMax {
		return Config{}, fmt.Errorf("udp-min %d > udp-max %d", cfg.UDPPortMin, cfg.UDPPortMax)
	}
	if (cfg.TLSCert == "") != (cfg.TLSKey == "") {
		return Config{}, fmt.Errorf("tls-cert and tls-key must be set together")
	}
	return cfg, nil
}
