package token

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

var secret = []byte("test-secret-0123456789abcdef")

func claims() Claims {
	return Claims{
		Channel: "#swift", Room: "swift", Account: "Ryan", Nick: "Ryan",
		Role: "op", Flags: FlagIdentifiedOnly,
		IssuedAt: 1753000000, ExpiresAt: 1753000600,
	}
}

func TestSignVerifyRoundTrip(t *testing.T) {
	tok, err := Sign(claims(), secret)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Verify(tok, secret, time.Unix(1753000100, 0))
	if err != nil {
		t.Fatal(err)
	}
	if got != claims() {
		t.Errorf("round trip mismatch: %+v", got)
	}
}

func TestExpired(t *testing.T) {
	tok, _ := Sign(claims(), secret)
	if _, err := Verify(tok, secret, time.Unix(1753000601, 0)); !errors.Is(err, ErrExpired) {
		t.Fatalf("want ErrExpired, got %v", err)
	}
}

func TestBadSignature(t *testing.T) {
	tok, _ := Sign(claims(), secret)
	if _, err := Verify(tok, []byte("wrong-secret"), time.Unix(1753000100, 0)); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("want ErrBadSignature, got %v", err)
	}
	// Tampered payload must also fail: flip one payload char.
	parts := strings.SplitN(tok, ".", 2)
	tampered := parts[0][:len(parts[0])-1] + "A" + "." + parts[1]
	if _, err := Verify(tampered, secret, time.Unix(1753000100, 0)); err == nil {
		t.Fatal("tampered token verified")
	}
}

func TestMalformed(t *testing.T) {
	for _, tok := range []string{"", "no-dot", "a.b.c", strings.Repeat("x", 2000) + ".sig"} {
		if _, err := Verify(tok, secret, time.Unix(1753000100, 0)); !errors.Is(err, ErrMalformed) && !errors.Is(err, ErrBadSignature) {
			t.Errorf("Verify(%.20q) = %v, want malformed/bad-signature", tok, err)
		}
	}
}

func TestLengthBudget(t *testing.T) {
	c := claims()
	c.Account = strings.Repeat("N", 30) // worst-case IRC-ish lengths
	c.Nick = strings.Repeat("N", 30)
	c.Channel = "#" + strings.Repeat("c", 32)
	c.Room = strings.Repeat("r", 32)
	tok, _ := Sign(c, secret)
	// The real hard requirement (design spec) is that the tokenized link fit a
	// single IRC NOTICE line (~440 usable chars); typical tokens land 180-250.
	// This worst-case IRC-ish payload deterministically produces ~310 chars, so
	// 320 is the sanity ceiling — well inside the NOTICE line and maxTokenLen.
	if len(tok) > 320 {
		t.Errorf("worst-case token %d chars, budget 320", len(tok))
	}
}

// TestVectors pins the cross-implementation contract with the Anope module.
func TestVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vs []struct {
		Name   string `json:"name"`
		Secret string `json:"secret"`
		Token  string `json:"token"`
		Now    int64  `json:"now"`
		Want   string `json:"want"` // "ok" | "expired" | "bad-signature"
		Claims Claims `json:"claims"`
	}
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatal(err)
	}
	if len(vs) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range vs {
		got, err := Verify(v.Token, []byte(v.Secret), time.Unix(v.Now, 0))
		switch v.Want {
		case "ok":
			if err != nil {
				t.Errorf("%s: %v", v.Name, err)
			} else if got != v.Claims {
				t.Errorf("%s: claims %+v != %+v", v.Name, got, v.Claims)
			}
		case "expired":
			if !errors.Is(err, ErrExpired) {
				t.Errorf("%s: want ErrExpired, got %v", v.Name, err)
			}
		case "bad-signature":
			if !errors.Is(err, ErrBadSignature) {
				t.Errorf("%s: want ErrBadSignature, got %v", v.Name, err)
			}
		}
	}
}
