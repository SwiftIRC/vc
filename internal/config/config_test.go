package config

import (
	"log/slog"
	"testing"
)

func TestDefaults(t *testing.T) {
	cfg, err := Load(nil, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != ":8080" {
		t.Errorf("Addr = %q, want :8080", cfg.Addr)
	}
	if !cfg.AdhocRooms {
		t.Error("AdhocRooms should default to true")
	}
	if cfg.UDPPortMin != 50000 || cfg.UDPPortMax != 50199 {
		t.Errorf("UDP range = %d-%d, want 50000-50199", cfg.UDPPortMin, cfg.UDPPortMax)
	}
	if cfg.Secret != "" {
		t.Errorf("Secret should default empty, got %q", cfg.Secret)
	}
	if cfg.TrustProxy {
		t.Error("TrustProxy should default to false")
	}
}

func TestFlagBeatsEnv(t *testing.T) {
	env := map[string]string{"WVC_ADDR": ":9999", "WVC_SECRET": "envsecret", "WVC_ADHOC": "false"}
	cfg, err := Load([]string{"-addr", ":7777"}, func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != ":7777" {
		t.Errorf("flag should beat env, got %q", cfg.Addr)
	}
	if cfg.Secret != "envsecret" {
		t.Errorf("Secret = %q, want envsecret", cfg.Secret)
	}
	if cfg.AdhocRooms {
		t.Error("WVC_ADHOC=false should disable ad-hoc rooms")
	}
}

func TestInvertedUDPRangeRejected(t *testing.T) {
	if _, err := Load([]string{"-udp-min", "60000", "-udp-max", "50000"}, func(string) string { return "" }); err == nil {
		t.Fatal("want error for inverted UDP range")
	}
}

func TestLogLevelDefaultsToInfo(t *testing.T) {
	cfg, err := Load(nil, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LogLevel != slog.LevelInfo {
		t.Errorf("LogLevel = %v, want %v", cfg.LogLevel, slog.LevelInfo)
	}
}

func TestLogLevelFromEnvAndFlag(t *testing.T) {
	env := map[string]string{"WVC_LOG_LEVEL": "warn"}
	getenv := func(k string) string { return env[k] }

	cfg, err := Load(nil, getenv)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LogLevel != slog.LevelWarn {
		t.Errorf("env LogLevel = %v, want %v", cfg.LogLevel, slog.LevelWarn)
	}

	cfg, err = Load([]string{"-log-level", "debug"}, getenv)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LogLevel != slog.LevelDebug {
		t.Errorf("flag should beat env: LogLevel = %v, want %v", cfg.LogLevel, slog.LevelDebug)
	}
}

// A typo must fail loudly. Silently falling back to info is the worst outcome for
// the thing this setting exists for: someone turning debug on mid-incident, seeing
// no new output, and concluding the code paths are silent rather than that their
// value never parsed.
func TestInvalidLogLevelRejected(t *testing.T) {
	if _, err := Load([]string{"-log-level", "chatty"}, func(string) string { return "" }); err == nil {
		t.Fatal("want error for an unparseable log level")
	}
	if _, err := Load(nil, func(k string) string { return map[string]string{"WVC_LOG_LEVEL": "debgu"}[k] }); err == nil {
		t.Fatal("want error for an unparseable log level from the environment")
	}
}
