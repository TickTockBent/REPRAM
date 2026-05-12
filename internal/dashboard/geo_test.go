package dashboard

import (
	"net"
	"testing"
)

func TestGeoEmptyPathReturnsQuestion(t *testing.T) {
	g, err := NewGeo("")
	if err != nil {
		t.Fatalf("NewGeo(\"\"): %v", err)
	}
	defer g.Close()
	if got := g.Region(net.ParseIP("8.8.8.8")); got != "?" {
		t.Errorf("expected ? for empty-db lookup, got %s", got)
	}
}

func TestGeoMissingFileReturnsQuestion(t *testing.T) {
	g, err := NewGeo("/nonexistent/path.mmdb")
	if err != nil {
		t.Fatalf("NewGeo should not error on missing file (treat as no-db), got %v", err)
	}
	defer g.Close()
	if got := g.Region(net.ParseIP("8.8.8.8")); got != "?" {
		t.Errorf("expected ? for missing-db lookup, got %s", got)
	}
}

func TestGeoNilIPReturnsQuestion(t *testing.T) {
	g, _ := NewGeo("")
	if got := g.Region(nil); got != "?" {
		t.Errorf("expected ? for nil ip, got %s", got)
	}
}
