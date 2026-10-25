package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	randv2 "math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Intent struct {
	Kind    string `json:"kind"`
	Query   string `json:"query"`
	Shuffle *bool  `json:"shuffle,omitempty"`
}

func normal(s string) string {
	return strings.ToLower(strings.TrimSpace(strings.ReplaceAll(s, "ё", "е")))
}
func randomID() string {
	var b [18]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

type Queue struct {
	Tracks       []Track `json:"tracks"`
	Index        int     `json:"index"`
	Revision     uint64  `json:"revision"`
	Shuffle      bool    `json:"shuffle"`
	SourceTracks []Track `json:"source_tracks,omitempty"`
	RadioSeed    int64   `json:"radio_seed,omitempty"`
	Repeat       string  `json:"repeat,omitempty"`
}
type StoredMedia struct {
	Media   *MediaSession
	Created time.Time
}
type Server struct {
	api          *API
	mu           sync.Mutex
	refill       sync.Mutex
	queues       map[string]*Queue
	generations  map[string]uint64
	media        map[string]StoredMedia
	root, origin string
}

func jsonOut(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
func (s *Server) saveLocked() error {
	return atomicJSON(filepath.Join(s.root, "queues.json"), s.queues)
}
func (s *Server) queueTrack(id string, next bool) (*Track, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	q := s.queues[id]
	if q == nil {
		return nil, nil
	}
	index := q.Index
	if next && repeatMode(q) != "track" {
		index++
	}
	if index < 0 || index >= len(q.Tracks) {
		return nil, nil
	}
	t := q.Tracks[index]
	return &t, nil
}
func (s *Server) summary(id string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	q := s.queues[id]
	if q == nil {
		return map[string]any{"count": 0, "track": nil}
	}
	var t *Track
	if q.Index >= 0 && q.Index < len(q.Tracks) {
		t = &q.Tracks[q.Index]
	}
	return map[string]any{"count": len(q.Tracks), "index": q.Index, "revision": q.Revision, "track": t,
		"shuffle": q.Shuffle, "repeat": repeatMode(q), "radio_seed": q.RadioSeed}
}
func (s *Server) play(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("device")
	var in Intent
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&in); err != nil {
		http.Error(w, "invalid request", 400)
		return
	}
	s.mu.Lock()
	if s.generations == nil {
		s.generations = map[string]uint64{}
	}
	s.generations[id]++
	generation := s.generations[id]
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	var tracks []Track
	var err error
	var radioSeed int64
	previous, _ := s.queueTrack(id, false)
	switch in.Kind {
	case "radio":
		if previous == nil {
			http.Error(w, "No current track for radio", 409)
			return
		}
		radioSeed = previous.ID
		tracks, err = s.api.radio(ctx, radioSeed)
	case "favorites":
		tracks, err = s.api.favorites(ctx)
	case "play", "track", "playlist", "playlist_id", "album", "artist":
		tracks, err = s.api.resolve(ctx, in)
	default:
		http.Error(w, "unsupported music request", 400)
		return
	}
	if err != nil {
		log.Printf("Tidal lookup: %v", err)
		http.Error(w, err.Error(), 502)
		return
	}
	playable := make([]Track, 0, len(tracks))
	for _, track := range tracks {
		if track.ID > 0 && (track.AllowStreaming == nil || *track.AllowStreaming) {
			playable = append(playable, track)
		}
	}
	tracks = playable
	if len(tracks) == 0 {
		http.Error(w, "Nothing found in Tidal", 404)
		return
	}
	shuffle := in.Kind == "playlist" || in.Kind == "playlist_id" || in.Kind == "favorites"
	if in.Shuffle != nil {
		shuffle = *in.Shuffle
	}
	original := append([]Track(nil), tracks...)
	if shuffle {
		var avoid int64
		if previous != nil {
			avoid = previous.ID
		}
		shuffleTracks(tracks, avoid)
	}
	// Resolve first playback before replacing a working queue.
	if _, err = s.api.stream(ctx, tracks[0].ID); err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	s.mu.Lock()
	if s.generations[id] != generation {
		s.mu.Unlock()
		http.Error(w, "Newer music request superseded this lookup", 409)
		return
	}
	revision := uint64(1)
	if old := s.queues[id]; old != nil {
		revision = old.Revision + 1
	}
	old := s.queues[id]
	repeat := "off"
	if shuffle || radioSeed != 0 {
		repeat = "queue"
	}
	s.queues[id] = &Queue{Tracks: tracks, Index: 0, Revision: revision, Shuffle: shuffle,
		SourceTracks: original, RadioSeed: radioSeed, Repeat: repeat}
	err = s.saveLocked()
	if err != nil {
		if old == nil {
			delete(s.queues, id)
		} else {
			s.queues[id] = old
		}
	}
	s.mu.Unlock()
	if err != nil {
		http.Error(w, "queue persistence failed", 500)
		return
	}
	jsonOut(w, s.summary(id))
}
func (s *Server) trackResponse(w http.ResponseWriter, r *http.Request, next bool) {
	if next {
		if err := s.ensureNext(r.Context(), r.PathValue("device")); err != nil {
			http.Error(w, "Tidal queue refill failed", 502)
			return
		}
	}
	t, err := s.queueTrack(r.PathValue("device"), next)
	if err != nil {
		http.Error(w, "queue error", 500)
		return
	}
	if t == nil {
		jsonOut(w, nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	stream, err := s.api.stream(ctx, t.ID)
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	id := randomID()
	media, err := makeMedia(stream, s.origin, id)
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	s.mu.Lock()
	for key, value := range s.media {
		if time.Since(value.Created) > 3*time.Hour {
			delete(s.media, key)
		}
	}
	s.media[id] = StoredMedia{Media: media, Created: time.Now()}
	cacheError := atomicJSON(filepath.Join(s.root, "media.json"), s.media)
	s.mu.Unlock()
	if cacheError != nil {
		http.Error(w, "media cache persistence failed", 500)
		return
	}
	suffix := "/r/direct"
	format := "MP3"
	if len(media.Manifest) > 0 {
		suffix = "/manifest.mpd"
	}
	jsonOut(w, map[string]any{"format": format, "url": s.origin + "/audio/" + id + suffix, "title": t.Title, "artist": t.Artist.Name, "id": t.ID, "duration": t.Duration})
}
func (s *Server) advance(w http.ResponseWriter, r *http.Request, delta int) {
	if delta > 0 {
		if err := s.ensureNext(r.Context(), r.PathValue("device")); err != nil {
			http.Error(w, "Tidal queue refill failed", 502)
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	q := s.queues[r.PathValue("device")]
	if q == nil {
		http.Error(w, "queue empty", 404)
		return
	}
	if delta == 2 {
		delta = 1
		if repeatMode(q) == "track" {
			delta = 0
		}
	}
	index := q.Index + delta
	if repeatMode(q) == "track" && index >= len(q.Tracks) {
		index = 0
	}
	if index < 0 {
		index = 0
	}
	if index > len(q.Tracks) {
		index = len(q.Tracks)
	}
	oldIndex, oldRevision := q.Index, q.Revision
	q.Index = index
	q.Revision++
	if err := s.saveLocked(); err != nil {
		q.Index, q.Revision = oldIndex, oldRevision
		http.Error(w, "queue persistence failed", 500)
		return
	}
	jsonOut(w, map[string]any{"ok": true, "index": q.Index})
}
func (s *Server) audio(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	stored, ok := s.media[r.PathValue("session")]
	s.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	m := stored.Media
	tail := r.PathValue("rest")
	if tail == "manifest.mpd" {
		w.Header().Set("Content-Type", m.MIME)
		w.Header().Set("Content-Length", strconv.Itoa(len(m.Manifest)))
		w.Write(m.Manifest)
		return
	}
	parts := strings.Split(tail, "/")
	if len(parts) < 2 || parts[0] != "r" {
		http.NotFound(w, r)
		return
	}
	remote, ok := m.Remotes[parts[1]]
	if !ok {
		http.NotFound(w, r)
		return
	}
	if len(parts) > 2 {
		if _, err := strconv.ParseUint(parts[2], 10, 64); err != nil {
			http.Error(w, "invalid segment", 400)
			return
		}
		remote = strings.ReplaceAll(strings.ReplaceAll(remote, "$Number$", parts[2]), "$Time$", parts[2])
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, remote, nil)
	if err != nil {
		http.Error(w, "media request failed", 502)
		return
	}
	for _, header := range []string{"Range", "If-Range"} {
		if value := r.Header.Get(header); value != "" {
			req.Header.Set(header, value)
		}
	}
	response, err := s.api.media.Do(req)
	if err != nil {
		http.Error(w, "media connection failed", 502)
		return
	}
	defer response.Body.Close()
	for _, header := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag"} {
		if value := response.Header.Get(header); value != "" {
			w.Header().Set(header, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	if r.Method != "HEAD" {
		io.Copy(w, response.Body)
	}
}
func (s *Server) handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, map[string]any{"ok": true, "service": "tidal"})
	})
	m.HandleFunc("POST /play/{device}", s.play)
	m.HandleFunc("GET /queue/{device}/current", func(w http.ResponseWriter, r *http.Request) { s.trackResponse(w, r, false) })
	m.HandleFunc("GET /queue/{device}/next", func(w http.ResponseWriter, r *http.Request) { s.trackResponse(w, r, true) })
	m.HandleFunc("GET /queue/{device}/status", func(w http.ResponseWriter, r *http.Request) { jsonOut(w, s.summary(r.PathValue("device"))) })
	m.HandleFunc("POST /queue/{device}/forward", func(w http.ResponseWriter, r *http.Request) { s.advance(w, r, 1) })
	m.HandleFunc("POST /queue/{device}/backward", func(w http.ResponseWriter, r *http.Request) { s.advance(w, r, -1) })
	m.HandleFunc("POST /queue/{device}/commit", func(w http.ResponseWriter, r *http.Request) {
		s.advance(w, r, 2)
	})
	m.HandleFunc("PATCH /queue/{device}/options", s.options)
	m.HandleFunc("DELETE /queue/{device}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("device")
		s.mu.Lock()
		defer s.mu.Unlock()
		old := s.queues[id]
		delete(s.queues, id)
		if err := s.saveLocked(); err != nil {
			if old != nil {
				s.queues[id] = old
			}
			http.Error(w, "queue persistence failed", 500)
			return
		}
		jsonOut(w, map[string]any{"ok": true})
	})
	m.HandleFunc("GET /audio/{session}/{rest...}", s.audio)
	return m
}
func main() {
	config := flag.String("config", "/var/lib/quasar-tidal/config.json", "Private Tidal config")
	check := flag.Bool("check-auth", false, "Check and refresh OAuth then exit")
	flag.Parse()
	api, err := loadAPI(*config)
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	err = api.session(ctx)
	cancel()
	if err != nil {
		log.Fatal(err)
	}
	if *check {
		fmt.Println("Tidal OAuth session verified")
		return
	}
	origin := os.Getenv("TIDAL_PUBLIC_ORIGIN")
	if origin == "" {
		log.Fatal("TIDAL_PUBLIC_ORIGIN missing")
	}
	s := &Server{api: api, queues: map[string]*Queue{}, media: map[string]StoredMedia{}, root: filepath.Dir(*config), origin: strings.TrimRight(origin, "/")}
	if data, err := os.ReadFile(filepath.Join(s.root, "queues.json")); err == nil {
		if err = json.Unmarshal(data, &s.queues); err != nil {
			log.Fatal("invalid queue state")
		}
	}
	if data, err := os.ReadFile(filepath.Join(s.root, "media.json")); err == nil {
		if err = json.Unmarshal(data, &s.media); err != nil {
			log.Fatal("invalid media cache state")
		}
		for key, value := range s.media {
			if time.Since(value.Created) > 3*time.Hour {
				delete(s.media, key)
			}
		}
	}
	server := &http.Server{Addr: "127.0.0.1:31119", Handler: s.handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second}
	log.Print("Tidal API ready on loopback:31119")
	if err = server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func shuffleTracks(tracks []Track, avoidFirst int64) {
	randv2.Shuffle(len(tracks), func(i, j int) { tracks[i], tracks[j] = tracks[j], tracks[i] })
	if len(tracks) > 1 && tracks[0].ID == avoidFirst {
		tracks[0], tracks[1] = tracks[1], tracks[0]
	}
}

func (s *Server) ensureNext(ctx context.Context, id string) error {
	s.refill.Lock()
	defer s.refill.Unlock()
	s.mu.Lock()
	q := s.queues[id]
	if q == nil || repeatMode(q) == "track" || q.Index+1 < len(q.Tracks) || (repeatMode(q) != "queue" && q.RadioSeed == 0) {
		s.mu.Unlock()
		return nil
	}
	revision, seed := q.Revision, q.RadioSeed
	original := append([]Track(nil), q.SourceTracks...)
	if len(original) == 0 {
		original = append([]Track(nil), q.Tracks...)
	}
	shuffle := q.Shuffle
	history := append([]Track(nil), q.Tracks...)
	s.mu.Unlock()
	var extra []Track
	var err error
	if seed != 0 {
		extra, err = s.api.radio(ctx, seed)
		if err != nil {
			return err
		}
		recent := map[int64]bool{}
		start := len(history) - 30
		if start < 0 {
			start = 0
		}
		for _, t := range history[start:] {
			recent[t.ID] = true
		}
		filtered := []Track{}
		for _, t := range extra {
			if !recent[t.ID] {
				filtered = append(filtered, t)
			}
		}
		if len(filtered) > 0 {
			extra = filtered
		}
	} else {
		extra = original
		var previous int64
		if len(history) > 0 {
			previous = history[len(history)-1].ID
		}
		if shuffle {
			shuffleTracks(extra, previous)
		}
	}
	if len(extra) == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	q = s.queues[id]
	if q == nil || q.Revision != revision {
		return nil
	}
	oldTracks := q.Tracks
	q.Tracks = append(append([]Track(nil), q.Tracks...), extra...)
	if err = s.saveLocked(); err != nil {
		q.Tracks = oldTracks
		return err
	}
	return nil
}

func repeatMode(q *Queue) string {
	if q.Repeat != "" {
		return q.Repeat
	}
	// Preserve the existing looping behavior of queues saved before this option existed.
	if q.Shuffle || q.RadioSeed != 0 {
		return "queue"
	}
	return "off"
}

func (s *Server) options(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Shuffle *bool   `json:"shuffle"`
		Repeat  *string `json:"repeat"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 2048)).Decode(&in); err != nil || (in.Shuffle == nil && in.Repeat == nil) {
		http.Error(w, "invalid playback options", 400)
		return
	}
	if in.Repeat != nil && *in.Repeat != "off" && *in.Repeat != "track" && *in.Repeat != "queue" {
		http.Error(w, "invalid repeat mode", 400)
		return
	}
	id := r.PathValue("device")
	s.mu.Lock()
	old := s.queues[id]
	if old == nil || old.Index < 0 || old.Index >= len(old.Tracks) {
		s.mu.Unlock()
		http.Error(w, "queue empty", 404)
		return
	}
	updated := *old
	updated.Repeat = repeatMode(old)
	if in.Repeat != nil {
		updated.Repeat = *in.Repeat
	}
	if in.Shuffle != nil && *in.Shuffle != old.Shuffle {
		current := old.Tracks[old.Index]
		original := append([]Track(nil), old.SourceTracks...)
		if len(original) == 0 {
			original = append([]Track(nil), old.Tracks...)
		}
		updated.SourceTracks = original
		updated.Shuffle = *in.Shuffle
		if updated.Shuffle {
			rest := make([]Track, 0, len(original))
			for _, t := range original {
				if t.ID != current.ID {
					rest = append(rest, t)
				}
			}
			shuffleTracks(rest, 0)
			updated.Tracks = append([]Track{current}, rest...)
			updated.Index = 0
		} else {
			updated.Tracks = append([]Track(nil), original...)
			updated.Index = -1
			for i, t := range updated.Tracks {
				if t.ID == current.ID {
					updated.Index = i
					break
				}
			}
			if updated.Index < 0 {
				updated.Tracks = append([]Track{current}, updated.Tracks...)
				updated.Index = 0
			}
		}
	}
	updated.Revision++
	s.queues[id] = &updated
	if err := s.saveLocked(); err != nil {
		s.queues[id] = old
		s.mu.Unlock()
		http.Error(w, "queue persistence failed", 500)
		return
	}
	if s.generations != nil {
		s.generations[id]++
	}
	s.mu.Unlock()
	jsonOut(w, s.summary(id))
}
