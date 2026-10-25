package main

import (
	"errors"
	"html"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type MediaSession struct {
	Stream   Stream
	Remotes  map[string]string
	MIME     string
	Manifest []byte
}

var remoteURL = regexp.MustCompile(`https?://[^"<>\s]+`)

// xmlNamespace reports URLs that belong to the DASH document itself (for example
// xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance") rather than to media.
func xmlNamespace(host string) bool {
	switch strings.ToLower(host) {
	case "www.w3.org", "w3.org":
		return true
	}
	return false
}

func makeMedia(s Stream, origin, id string) (*MediaSession, error) {
	m := &MediaSession{Stream: s, Remotes: map[string]string{}}
	if len(s.Manifest) > 0 {
		var invalid bool
		n := 0
		m.Manifest = remoteURL.ReplaceAllFunc(s.Manifest, func(raw []byte) []byte {
			u := html.UnescapeString(string(raw))
			parsed, err := url.Parse(u)
			if err == nil && xmlNamespace(parsed.Hostname()) {
				return raw
			}
			if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" {
				invalid = true
				return raw
			}
			key := strconv.Itoa(n)
			n++
			m.Remotes[key] = u
			local := origin + "/audio/" + id + "/r/" + key
			if strings.Contains(u, "$Number$") {
				local += "/$Number$"
			} else if strings.Contains(u, "$Time$") {
				local += "/$Time$"
			}
			return []byte(local)
		})
		if invalid {
			return nil, errors.New("unsafe stream URL")
		}
		m.MIME = "application/dash+xml"
	} else {
		u, err := url.Parse(s.URL)
		if err != nil || u.Scheme != "https" || u.Hostname() == "" {
			return nil, errors.New("invalid stream URL")
		}
		m.Remotes["direct"] = s.URL
		m.MIME = "application/octet-stream"
	}
	return m, nil
}
