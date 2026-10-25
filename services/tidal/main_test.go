package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestPaginationLoadsSecondPage(t *testing.T) {
	calls := 0
	api := &API{cfg: Config{Country: "US"}, http: &http.Client{Transport: transportFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		offset := r.URL.Query().Get("offset")
		count := 100
		if offset == "100" {
			count = 2
		}
		items := make([]Track, count)
		for i := range items {
			items[i].ID = int64(calls*100 + i)
		}
		body, _ := json.Marshal(map[string]any{"items": items, "totalNumberOfItems": 102})
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(body))), Header: http.Header{}}, nil
	})}}
	tracks, err := pagedItems[Track](context.Background(), api, "/test", nil)
	if err != nil || len(tracks) != 102 || calls != 2 {
		t.Fatalf("pagination: len=%d calls=%d err=%v", len(tracks), calls, err)
	}
}
func TestCurrentAndNextDoNotAdvanceQueue(t *testing.T) {
	s := &Server{queues: map[string]*Queue{"test": {Tracks: []Track{{ID: 1}, {ID: 2}}, Index: 0}}, root: t.TempDir()}
	current, _ := s.queueTrack("test", false)
	next, _ := s.queueTrack("test", true)
	if current.ID != 1 || next.ID != 2 || s.queues["test"].Index != 0 {
		t.Fatal("lookahead mutated queue")
	}
	r := httptest.NewRequest("POST", "/queue/test/forward", nil)
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	if w.Code != 200 || s.queues["test"].Index != 1 {
		t.Fatal("forward failed")
	}
	next, _ = s.queueTrack("test", true)
	if next != nil {
		t.Fatal("end of queue returned a track")
	}
}
func TestMediaRejectsUnsafeURLAndPreservesDASHNamespace(t *testing.T) {
	if _, err := makeMedia(Stream{URL: "file:///etc/passwd"}, "https://local", "opaque"); err == nil {
		t.Fatal("unsafe URL accepted")
	}
	m, err := makeMedia(Stream{Manifest: []byte(`<MPD xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><SegmentTemplate media="https://audio.tidal.com/chunk-$Number$.mp4?secret=x"/></MPD>`)}, "https://local", "opaque")
	if err != nil || strings.Contains(string(m.Manifest), "secret=x") || !strings.Contains(string(m.Manifest), "www.w3.org") {
		t.Fatalf("manifest rewrite failed: %v", err)
	}
}
func TestEmptyQueueIsJSONNull(t *testing.T) {
	s := &Server{queues: map[string]*Queue{}}
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, httptest.NewRequest("GET", "/queue/test/current", nil))
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "null" {
		t.Fatal("empty queue contract broken")
	}
}

func TestShufflePreservesEveryTrackAndAvoidsImmediateRepeat(t *testing.T) {
	tracks := []Track{{ID: 1}, {ID: 2}, {ID: 3}, {ID: 4}}
	for i := 0; i < 40; i++ {
		shuffled := append([]Track(nil), tracks...)
		shuffleTracks(shuffled, 1)
		if shuffled[0].ID == 1 {
			t.Fatal("same first track repeated")
		}
		found := map[int64]bool{}
		for _, track := range shuffled {
			found[track.ID] = true
		}
		if len(found) != 4 {
			t.Fatal("shuffle duplicated or lost tracks")
		}
	}
}
func TestShuffleRefillsQueueAtEndWithoutRepeatingLastTrack(t *testing.T) {
	original := []Track{{ID: 1}, {ID: 2}, {ID: 3}}
	s := &Server{queues: map[string]*Queue{"test": {Tracks: original, SourceTracks: original, Index: 2, Shuffle: true}}, root: t.TempDir()}
	if err := s.ensureNext(context.Background(), "test"); err != nil {
		t.Fatal(err)
	}
	next, _ := s.queueTrack("test", true)
	if next == nil || next.ID == 3 {
		t.Fatal("shuffle cycle is empty or repeats last track")
	}
	if len(s.queues["test"].Tracks) != 6 {
		t.Fatal("shuffle cycle not appended")
	}
	if err := s.ensureNext(context.Background(), "test"); err != nil {
		t.Fatal(err)
	}
	if len(s.queues["test"].Tracks) != 6 {
		t.Fatal("duplicate lookahead appended another cycle")
	}
}

func TestRepeatOneRepeatsAutomaticallyButManualNextStillSkips(t *testing.T) {
	s := &Server{queues: map[string]*Queue{"test": {Tracks: []Track{{ID: 1}, {ID: 2}}, Index: 0, Repeat: "track"}}, root: t.TempDir()}
	next, _ := s.queueTrack("test", true)
	if next.ID != 1 {
		t.Fatal("repeat one lookahead selected another song")
	}
	for _, path := range []string{"commit", "forward"} {
		w := httptest.NewRecorder()
		s.handler().ServeHTTP(w, httptest.NewRequest("POST", "/queue/test/"+path, nil))
		if w.Code != 200 {
			t.Fatal(path, w.Code)
		}
		want := 0
		if path == "forward" {
			want = 1
		}
		if s.queues["test"].Index != want {
			t.Fatal("repeat one did not distinguish automatic and manual advance")
		}
	}
}

func TestShuffleToggleKeepsCurrentTrackAndRestoresOriginalOrder(t *testing.T) {
	original := []Track{{ID: 1}, {ID: 2}, {ID: 3}}
	s := &Server{queues: map[string]*Queue{"test": {Tracks: original, SourceTracks: original, Index: 1, Repeat: "queue"}}, root: t.TempDir()}
	for _, enabled := range []bool{true, false} {
		body, _ := json.Marshal(map[string]any{"shuffle": enabled})
		w := httptest.NewRecorder()
		s.handler().ServeHTTP(w, httptest.NewRequest("PATCH", "/queue/test/options", strings.NewReader(string(body))))
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		current, _ := s.queueTrack("test", false)
		if current.ID != 2 {
			t.Fatal("mode change switched current song")
		}
	}
	q := s.queues["test"]
	if q.Index != 1 || q.Tracks[0].ID != 1 || q.Tracks[2].ID != 3 {
		t.Fatal("original order not restored")
	}
}

func TestOrderedRepeatQueueWrapsAndOffStops(t *testing.T) {
	for _, mode := range []string{"off", "queue"} {
		tracks := []Track{{ID: 1}, {ID: 2}}
		s := &Server{queues: map[string]*Queue{"test": {Tracks: tracks, SourceTracks: tracks, Index: 1, Repeat: mode}}, root: t.TempDir()}
		if err := s.ensureNext(context.Background(), "test"); err != nil {
			t.Fatal(err)
		}
		next, _ := s.queueTrack("test", true)
		if mode == "queue" && (next == nil || next.ID != 1) {
			t.Fatal("ordered queue did not wrap")
		}
		if mode == "off" && next != nil {
			t.Fatal("repeat off must stop at queue end")
		}
	}
}
