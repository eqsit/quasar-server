package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Tokens struct {
	Access  string `json:"access_token"`
	Refresh string `json:"refresh_token"`
	Type    string `json:"token_type"`
	Expires int64  `json:"expires_in"`
}
type Config struct {
	Tokens       Tokens `json:"auth_tokens"`
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	Country      string `json:"country_code"`
	UserID       int64  `json:"user_id"`
	ProxyURL     string `json:"proxy_url,omitempty"`
	Listen       string `json:"listen"`
	IPC          string `json:"ipc"`
	Quality      string `json:"quality"`
}
type Artist struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}
type Track struct {
	ID             int64    `json:"id"`
	Title          string   `json:"title"`
	Duration       int      `json:"duration"`
	AllowStreaming *bool    `json:"allowStreaming,omitempty"`
	Artist         Artist   `json:"artist"`
	Artists        []Artist `json:"artists,omitempty"`
	Album          struct {
		ID    int64  `json:"id"`
		Title string `json:"title"`
	} `json:"album"`
}
type Playlist struct {
	UUID           string `json:"uuid"`
	Title          string `json:"title"`
	NumberOfTracks int    `json:"numberOfTracks"`
}
type Album struct {
	ID     int64  `json:"id"`
	Title  string `json:"title"`
	Artist Artist `json:"artist"`
}
type API struct {
	mu    sync.Mutex
	cfg   Config
	path  string
	http  *http.Client
	media *http.Client
}

func atomicJSON(path string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	tmp := path + ".tmp"
	f, e := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		os.Remove(tmp)
		return e
	}
	return os.Rename(tmp, path)
}
func loadAPI(path string) (*API, error) {
	b, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	a := &API{path: path}
	if e = json.Unmarshal(b, &a.cfg); e != nil {
		return nil, errors.New("invalid private configuration")
	}
	if a.cfg.Tokens.Access == "" {
		return nil, errors.New("Tidal account is not configured")
	}
	if a.cfg.Country == "" {
		a.cfg.Country = "US"
	}
	if a.cfg.Listen == "" {
		a.cfg.Listen = "127.0.0.1:18888"
	}
	if a.cfg.IPC == "" {
		a.cfg.IPC = "127.0.0.1:9875"
	}
	if a.cfg.Quality == "" {
		a.cfg.Quality = "LOSSLESS"
	}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.MaxIdleConnsPerHost = 4
	t.ResponseHeaderTimeout = 20 * time.Second
	if a.cfg.ProxyURL != "" {
		u, e := url.Parse(a.cfg.ProxyURL)
		if e != nil {
			return nil, errors.New("invalid configured proxy")
		}
		t.Proxy = http.ProxyURL(u)
	} else {
		t.Proxy = nil
	}
	a.http = &http.Client{Transport: t, Timeout: 25 * time.Second}
	a.media = &http.Client{Transport: t}
	return a, nil
}
func (a *API) refresh(ctx context.Context) error {
	f := url.Values{"client_id": {a.cfg.ClientID}, "refresh_token": {a.cfg.Tokens.Refresh}, "grant_type": {"refresh_token"}, "scope": {"r_usr w_usr w_sub"}}
	if a.cfg.ClientSecret != "" {
		f.Set("client_secret", a.cfg.ClientSecret)
	}
	r, e := http.NewRequestWithContext(ctx, "POST", "https://auth.tidal.com/v1/oauth2/token", strings.NewReader(f.Encode()))
	if e != nil {
		return e
	}
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, e := a.http.Do(r)
	if e != nil {
		return errors.New("Tidal authentication connection failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("Tidal session renewal failed (HTTP %d)", resp.StatusCode)
	}
	t := a.cfg.Tokens
	if e = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&t); e != nil {
		return errors.New("invalid token renewal response")
	}
	if t.Access == "" {
		return errors.New("empty renewed token")
	}
	a.cfg.Tokens = t
	return atomicJSON(a.path, &a.cfg)
}
func (a *API) get(ctx context.Context, path string, params url.Values, out any) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if params == nil {
		params = url.Values{}
	}
	params.Set("countryCode", a.cfg.Country)
	for attempt := 0; attempt < 2; attempt++ {
		u := "https://api.tidal.com/v1" + path + "?" + params.Encode()
		r, e := http.NewRequestWithContext(ctx, "GET", u, nil)
		if e != nil {
			return e
		}
		r.Header.Set("Authorization", "Bearer "+a.cfg.Tokens.Access)
		resp, e := a.http.Do(r)
		if e != nil {
			return errors.New("Tidal connection failed")
		}
		if resp.StatusCode == 401 && attempt == 0 {
			resp.Body.Close()
			if e = a.refresh(ctx); e != nil {
				return e
			}
			continue
		}
		if resp.StatusCode != 200 {
			resp.Body.Close()
			return fmt.Errorf("Tidal request failed (HTTP %d)", resp.StatusCode)
		}
		e = json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
		resp.Body.Close()
		if e != nil {
			return errors.New("invalid Tidal response")
		}
		return nil
	}
	return errors.New("Tidal login expired")
}
func (a *API) session(ctx context.Context) error {
	var s struct {
		UserID  int64  `json:"userId"`
		Country string `json:"countryCode"`
	}
	if e := a.get(ctx, "/sessions", nil, &s); e != nil {
		return e
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cfg.UserID = s.UserID
	if s.Country != "" {
		a.cfg.Country = s.Country
	}
	return atomicJSON(a.path, a.cfg)
}
func (a *API) searchTracks(ctx context.Context, q string) ([]Track, error) {
	var r struct {
		Items []Track `json:"items"`
	}
	e := a.get(ctx, "/search/tracks", url.Values{"query": {q}, "limit": {"25"}}, &r)
	return r.Items, e
}
func (a *API) track(ctx context.Context, id string) (Track, error) {
	var t Track
	e := a.get(ctx, "/tracks/"+url.PathEscape(id), nil, &t)
	return t, e
}
func pagedItems[T any](ctx context.Context, a *API, path string, params url.Values) ([]T, error) {
	var all []T
	if params == nil {
		params = url.Values{}
	}
	params.Set("limit", "100")
	for offset := 0; offset < 100000; offset += 100 {
		params.Set("offset", fmt.Sprint(offset))
		var page struct {
			Items []T `json:"items"`
			Total int `json:"totalNumberOfItems"`
		}
		if err := a.get(ctx, path, params, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Items...)
		if len(page.Items) < 100 || (page.Total > 0 && len(all) >= page.Total) {
			return all, nil
		}
	}
	return nil, errors.New("Tidal collection exceeds supported size")
}
func (a *API) favorites(ctx context.Context) ([]Track, error) {
	type item struct {
		Item Track `json:"item"`
	}
	items, err := pagedItems[item](ctx, a, fmt.Sprintf("/users/%d/favorites/tracks", a.cfg.UserID), nil)
	var tracks []Track
	for _, x := range items {
		if x.Item.ID > 0 {
			tracks = append(tracks, x.Item)
		}
	}
	return tracks, err
}
func (a *API) playlists(ctx context.Context) ([]Playlist, error) {
	return pagedItems[Playlist](ctx, a, fmt.Sprintf("/users/%d/playlists", a.cfg.UserID), nil)
}
func (a *API) playlistTracks(ctx context.Context, id string) ([]Track, error) {
	type item struct {
		Item Track `json:"item"`
	}
	items, err := pagedItems[item](ctx, a, "/playlists/"+url.PathEscape(id)+"/items", nil)
	var tracks []Track
	for _, x := range items {
		if x.Item.ID > 0 {
			tracks = append(tracks, x.Item)
		}
	}
	return tracks, err
}
func bestPlaylist(ps []Playlist, q string) (Playlist, bool) {
	for _, p := range ps {
		if normal(p.Title) == normal(q) {
			return p, true
		}
	}
	for _, p := range ps {
		if strings.Contains(normal(p.Title), normal(q)) {
			return p, true
		}
	}
	return Playlist{}, false
}
func (a *API) resolve(ctx context.Context, in Intent) ([]Track, error) {
	if in.Kind == "track" {
		t, e := a.track(ctx, in.Query)
		return []Track{t}, e
	}
	if in.Kind == "playlist_id" {
		return a.playlistTracks(ctx, in.Query)
	}
	if in.Kind == "playlist" {
		ps, e := a.playlists(ctx)
		if e != nil {
			return nil, e
		}
		if in.Query == "" && len(ps) > 0 {
			return a.playlistTracks(ctx, ps[0].UUID)
		}
		if p, ok := bestPlaylist(ps, in.Query); ok {
			return a.playlistTracks(ctx, p.UUID)
		}
		var r struct {
			Items []Playlist `json:"items"`
		}
		e = a.get(ctx, "/search/playlists", url.Values{"query": {in.Query}, "limit": {"10"}}, &r)
		if e != nil {
			return nil, e
		}
		if len(r.Items) == 0 {
			return nil, errors.New("Плейлист в Tidal не найден")
		}
		return a.playlistTracks(ctx, r.Items[0].UUID)
	}
	if in.Kind == "album" {
		var r struct {
			Items []Album `json:"items"`
		}
		if e := a.get(ctx, "/search/albums", url.Values{"query": {in.Query}, "limit": {"5"}}, &r); e != nil {
			return nil, e
		}
		if len(r.Items) == 0 {
			return nil, errors.New("Альбом не найден")
		}
		var t struct {
			Items []Track `json:"items"`
		}
		e := a.get(ctx, fmt.Sprintf("/albums/%d/tracks", r.Items[0].ID), url.Values{"limit": {"100"}}, &t)
		return t.Items, e
	}
	if in.Kind == "artist" {
		var r struct {
			Items []Artist `json:"items"`
		}
		if e := a.get(ctx, "/search/artists", url.Values{"query": {in.Query}, "limit": {"5"}}, &r); e != nil {
			return nil, e
		}
		if len(r.Items) == 0 {
			return nil, errors.New("Исполнитель не найден")
		}
		var t struct {
			Items []Track `json:"items"`
		}
		e := a.get(ctx, fmt.Sprintf("/artists/%d/toptracks", r.Items[0].ID), url.Values{"limit": {"50"}}, &t)
		return t.Items, e
	}
	return a.searchTracks(ctx, in.Query)
}

type Stream struct {
	Manifest           []byte
	MIME, URL, Quality string
}

func (a *API) stream(ctx context.Context, id int64) (Stream, error) {
	var last error
	for _, q := range []string{a.cfg.Quality, "HIGH"} {
		var r struct {
			Manifest string `json:"manifest"`
			MIME     string `json:"manifestMimeType"`
			Quality  string `json:"audioQuality"`
		}
		if e := a.get(ctx, fmt.Sprintf("/tracks/%d/playbackinfopostpaywall", id), url.Values{"audioquality": {q}, "playbackmode": {"STREAM"}, "assetpresentation": {"FULL"}}, &r); e != nil {
			last = e
			continue
		}
		b, e := base64.StdEncoding.DecodeString(r.Manifest)
		if e != nil {
			last = errors.New("invalid audio manifest")
			continue
		}
		if strings.Contains(r.MIME, "dash+xml") {
			if strings.Contains(string(b), "ContentProtection") {
				last = errors.New("Этот поток требует DRM-плеер")
				continue
			}
			return Stream{Manifest: b, MIME: "application/dash+xml", Quality: r.Quality}, nil
		}
		var m struct {
			URLs       []string `json:"urls"`
			Encryption string   `json:"encryptionType"`
		}
		if json.Unmarshal(b, &m) == nil && len(m.URLs) > 0 && (m.Encryption == "NONE" || m.Encryption == "") {
			return Stream{URL: m.URLs[0], Quality: r.Quality}, nil
		}
		last = errors.New("Неподдерживаемый формат потока Tidal")
	}
	return Stream{}, last
}
func dataPath(root, name string) string { return filepath.Join(root, name) }

func (a *API) radio(ctx context.Context, id int64) ([]Track, error) {
	var result struct {
		Items []Track `json:"items"`
	}
	err := a.get(ctx, fmt.Sprintf("/tracks/%d/radio", id), url.Values{"limit": {"100"}}, &result)
	tracks := []Track{}
	for _, t := range result.Items {
		if t.ID > 0 && t.ID != id {
			tracks = append(tracks, t)
		}
	}
	return tracks, err
}
