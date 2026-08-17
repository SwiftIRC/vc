// Package token implements the HMAC-signed identity tokens issued by the
// Anope module and verified by coyote. Format:
// base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload-b64-bytes)).
// The signature covers the encoded payload string, so verifiers never
// re-marshal JSON and any issuer implementation interoperates.
package token

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type Claims struct {
	Channel   string `json:"c"`
	Room      string `json:"r"`
	Account   string `json:"a"`
	Nick      string `json:"n"`
	Role      string `json:"o"`
	Flags     int    `json:"f"`
	IssuedAt  int64  `json:"i"`
	ExpiresAt int64  `json:"e"`
}

const FlagIdentifiedOnly = 1

const maxTokenLen = 1024

var (
	ErrMalformed    = errors.New("token: malformed")
	ErrBadSignature = errors.New("token: bad signature")
	ErrExpired      = errors.New("token: expired")
)

func Sign(c Claims, secret []byte) (string, error) {
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	p64 := base64.RawURLEncoding.EncodeToString(payload)
	return p64 + "." + sign64(p64, secret), nil
}

func Verify(tok string, secret []byte, now time.Time) (Claims, error) {
	if len(tok) == 0 || len(tok) > maxTokenLen {
		return Claims{}, ErrMalformed
	}
	p64, s64, ok := strings.Cut(tok, ".")
	if !ok || strings.Contains(s64, ".") {
		return Claims{}, ErrMalformed
	}
	if !hmac.Equal([]byte(sign64(p64, secret)), []byte(s64)) {
		return Claims{}, ErrBadSignature
	}
	payload, err := base64.RawURLEncoding.DecodeString(p64)
	if err != nil {
		return Claims{}, ErrMalformed
	}
	var c Claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return Claims{}, ErrMalformed
	}
	if now.Unix() >= c.ExpiresAt {
		return Claims{}, ErrExpired
	}
	return c, nil
}

func sign64(p64 string, secret []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(p64))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
