package config

import "testing"

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
