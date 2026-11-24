package main

import (
	"fmt"
	"strings"
	"unicode"

	"go.mau.fi/whatsmeow/types"
)

func canonicalJID(jid types.JID) string {
	clean := jid.ToNonAD()
	if clean.User == "" {
		return ""
	}
	if clean.Server == types.DefaultUserServer {
		return clean.User + "@c.us"
	}
	return clean.String()
}

func digitsOnly(input string) string {
	var b strings.Builder
	b.Grow(len(input))
	for _, r := range input {
		if unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func phoneDigitsFromJID(jid types.JID) string {
	clean := jid.ToNonAD()
	if clean.Server != types.DefaultUserServer {
		return ""
	}
	return digitsOnly(clean.User)
}

func parseInputJID(raw string) (types.JID, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return types.EmptyJID, fmt.Errorf("empty jid")
	}
	if strings.HasSuffix(strings.ToLower(s), "@c.us") {
		s = s[:len(s)-5] + "@" + types.DefaultUserServer
	}
	if !strings.Contains(s, "@") {
		digits := digitsOnly(s)
		if digits == "" {
			return types.EmptyJID, fmt.Errorf("invalid jid %q", raw)
		}
		return types.NewJID(digits, types.DefaultUserServer), nil
	}
	jid, err := types.ParseJID(s)
	if err != nil {
		return types.EmptyJID, fmt.Errorf("invalid jid %q: %w", raw, err)
	}
	if jid.User == "" || jid.Server == "" {
		return types.EmptyJID, fmt.Errorf("incomplete jid %q", raw)
	}
	return jid.ToNonAD(), nil
}
