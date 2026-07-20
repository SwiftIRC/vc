// Package config holds process configuration for webrtc-chat.
package config

import (
	"flag"
	"fmt"
	"io"
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

	fs := flag.NewFlagSet("webrtc-chat", flag.ContinueOnError)
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
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	if cfg.UDPPortMin > cfg.UDPPortMax {
		return Config{}, fmt.Errorf("udp-min %d > udp-max %d", cfg.UDPPortMin, cfg.UDPPortMax)
	}
	if (cfg.TLSCert == "") != (cfg.TLSKey == "") {
		return Config{}, fmt.Errorf("tls-cert and tls-key must be set together")
	}
	return cfg, nil
}
