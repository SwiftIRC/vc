package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/ryanwohara/webrtc-chat/internal/room"
)

func get(t *testing.T, url string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

func provision(t *testing.T, url, secret, body string) int {
	t.Helper()
	req, _ := http.NewRequest("POST", url+"/api/provision", strings.NewReader(body))
	if secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func TestRoomPeek(t *testing.T) {
	h, srv := newTestHub(t, "", true)
	if code, m := get(t, srv.URL+"/api/rooms/ghost"); code != 200 || m["count"].(float64) != 0 {
		t.Errorf("ghost: %d %v", code, m)
	}
	rm, _ := h.reg.Resolve("busy", nil)
	rm.Join(&room.Participant{ID: "p1", Name: "a", Role: room.RoleUser, Conn: nopConn{}}, "")
	rm.SetLock("p1", "pw")
	if _, m := get(t, srv.URL+"/api/rooms/busy"); m["count"].(float64) != 1 || m["locked"] != true {
		t.Errorf("busy: %v", m)
	}
	if code, _ := get(t, srv.URL+"/api/rooms/Bad!Slug"); code != 400 {
		t.Errorf("bad slug code = %d", code)
	}
}

func TestProvisionAuth(t *testing.T) {
	_, srv := newTestHub(t, testSecret, false)
	body := `{"channel":"#swift","room":"swift","settings":{"identifiedOnly":false}}`
	if code := provision(t, srv.URL, "", body); code != 401 {
		t.Errorf("no auth = %d", code)
	}
	if code := provision(t, srv.URL, "wrong", body); code != 401 {
		t.Errorf("wrong secret = %d", code)
	}
	if code := provision(t, srv.URL, testSecret, body); code != 204 {
		t.Errorf("good secret = %d", code)
	}
	if code := provision(t, srv.URL, testSecret, `{"room":"Bad!"}`); code != 400 {
		t.Errorf("bad slug = %d", code)
	}
	// provisioning makes the room joinable in channel-rooms-only mode
	c := dialRoom(t, srv, "swift")
	send(t, c, map[string]any{"type": "join", "name": "guest"})
	recv(t, c, "joined")
}

func TestProvisionDisabledWithoutSecret(t *testing.T) {
	_, srv := newTestHub(t, "", true)
	body := `{"channel":"#x","room":"x","settings":{}}`
	if code := provision(t, srv.URL, "anything", body); code != 403 {
		t.Errorf("no-secret server = %d", code)
	}
}
