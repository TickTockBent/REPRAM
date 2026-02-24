package storage

import (
	"sync"
	"testing"
	"time"
)

func newTestStore(maxBytes int64) *MemoryStore {
	return NewMemoryStore(maxBytes)
}

func TestPutAndGet(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	err := store.Put("key1", []byte("hello"), 5*time.Second)
	if err != nil {
		t.Fatalf("Put failed: %v", err)
	}

	data, ok := store.Get("key1")
	if !ok {
		t.Fatal("Get returned not found for existing key")
	}
	if string(data) != "hello" {
		t.Fatalf("Get returned %q, want %q", data, "hello")
	}
}

func TestGetMissing(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	data, ok := store.Get("nonexistent")
	if ok {
		t.Fatalf("Get returned found for missing key, data: %q", data)
	}
}

func TestTTLExpiration(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	err := store.Put("expiring", []byte("data"), 50*time.Millisecond)
	if err != nil {
		t.Fatalf("Put failed: %v", err)
	}

	// Should exist immediately
	if _, ok := store.Get("expiring"); !ok {
		t.Fatal("key should exist before TTL expires")
	}

	time.Sleep(100 * time.Millisecond)

	// Should be gone after TTL
	if _, ok := store.Get("expiring"); ok {
		t.Fatal("key should not exist after TTL expires")
	}
}

func TestGetWithMetadata(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	ttl := 10 * time.Second
	before := time.Now()
	err := store.Put("meta", []byte("value"), ttl)
	if err != nil {
		t.Fatalf("Put failed: %v", err)
	}

	data, createdAt, originalTTL, ok := store.GetWithMetadata("meta")
	if !ok {
		t.Fatal("GetWithMetadata returned not found")
	}
	if string(data) != "value" {
		t.Fatalf("data = %q, want %q", data, "value")
	}
	if originalTTL != ttl {
		t.Fatalf("TTL = %v, want %v", originalTTL, ttl)
	}
	if createdAt.Before(before) {
		t.Fatalf("CreatedAt %v is before test start %v", createdAt, before)
	}
}

func TestGetWithMetadataExpired(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	store.Put("temp", []byte("data"), 50*time.Millisecond)
	time.Sleep(100 * time.Millisecond)

	_, _, _, ok := store.GetWithMetadata("temp")
	if ok {
		t.Fatal("GetWithMetadata should return not found for expired key")
	}
}

func TestOverwrite(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	store.Put("key", []byte("first"), 5*time.Second)
	store.Put("key", []byte("second"), 5*time.Second)

	data, ok := store.Get("key")
	if !ok {
		t.Fatal("Get returned not found after overwrite")
	}
	if string(data) != "second" {
		t.Fatalf("Get returned %q after overwrite, want %q", data, "second")
	}
}

func TestOverwriteRefreshesTTL(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	store.Put("key", []byte("v1"), 100*time.Millisecond)
	time.Sleep(60 * time.Millisecond)

	// Overwrite with fresh TTL before expiration
	store.Put("key", []byte("v2"), 200*time.Millisecond)
	time.Sleep(60 * time.Millisecond)

	// Original TTL (100ms) would have expired by now, but overwrite refreshed it
	data, ok := store.Get("key")
	if !ok {
		t.Fatal("key should still exist after overwrite refreshed TTL")
	}
	if string(data) != "v2" {
		t.Fatalf("data = %q, want %q", data, "v2")
	}
}

// Verify Get returns a copy, not a reference to internal data
func TestGetReturnsCopy(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	store.Put("key", []byte("original"), 5*time.Second)

	data, _ := store.Get("key")
	data[0] = 'X' // mutate the returned slice

	data2, _ := store.Get("key")
	if string(data2) != "original" {
		t.Fatalf("internal data was mutated via returned slice: got %q", data2)
	}
}

// Verify Put copies input, so caller mutations don't affect stored data
func TestPutCopiesInput(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	input := []byte("original")
	store.Put("key", input, 5*time.Second)
	input[0] = 'X' // mutate the input slice after Put

	data, _ := store.Get("key")
	if string(data) != "original" {
		t.Fatalf("stored data was mutated via input slice: got %q", data)
	}
}

func TestScan(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	store.Put("a", []byte("1"), 5*time.Second)
	store.Put("b", []byte("2"), 5*time.Second)
	store.Put("expired", []byte("3"), 50*time.Millisecond)

	time.Sleep(100 * time.Millisecond)

	keys := store.Scan()
	if len(keys) != 2 {
		t.Fatalf("Scan returned %d keys, want 2", len(keys))
	}

	found := map[string]bool{}
	for _, k := range keys {
		found[k] = true
	}
	if !found["a"] || !found["b"] {
		t.Fatalf("Scan returned %v, want [a, b]", keys)
	}
}

func TestRange(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	store.Put("x", []byte("1"), 5*time.Second)
	store.Put("y", []byte("2"), 5*time.Second)

	visited := map[string]bool{}
	store.Range(func(key string, ttl int) bool {
		visited[key] = true
		if ttl <= 0 || ttl > 5 {
			t.Errorf("unexpected TTL %d for key %s", ttl, key)
		}
		return true
	})

	if len(visited) != 2 {
		t.Fatalf("Range visited %d keys, want 2", len(visited))
	}
}

func TestRangeEarlyStop(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	store.Put("a", []byte("1"), 5*time.Second)
	store.Put("b", []byte("2"), 5*time.Second)
	store.Put("c", []byte("3"), 5*time.Second)

	count := 0
	store.Range(func(key string, ttl int) bool {
		count++
		return false // stop after first
	})

	if count != 1 {
		t.Fatalf("Range visited %d keys after returning false, want 1", count)
	}
}

func TestGetStats(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	store.Put("a", []byte("hello"), 5*time.Second)
	store.Put("b", []byte("world!"), 5*time.Second)

	count, size := store.GetStats()
	if count != 2 {
		t.Fatalf("count = %d, want 2", count)
	}
	if size != 11 {
		t.Fatalf("size = %d, want 11", size)
	}
}

// --- Capacity limit tests ---

func TestCapacityLimitRejectsWrite(t *testing.T) {
	store := newTestStore(10) // 10 bytes max
	defer store.Close()

	err := store.Put("small", []byte("12345"), 5*time.Second)
	if err != nil {
		t.Fatalf("first Put should succeed: %v", err)
	}

	err = store.Put("toobig", []byte("123456"), 5*time.Second)
	if err != ErrStoreFull {
		t.Fatalf("second Put should return ErrStoreFull, got: %v", err)
	}

	// Original data should still be intact
	data, ok := store.Get("small")
	if !ok || string(data) != "12345" {
		t.Fatal("existing data should be unaffected by rejected write")
	}
}

func TestCapacityLimitOverwriteAllowed(t *testing.T) {
	store := newTestStore(10)
	defer store.Close()

	store.Put("key", []byte("12345"), 5*time.Second) // 5 bytes

	// Overwrite with larger value that still fits (old 5 subtracted, new 10 added = 10 total)
	err := store.Put("key", []byte("1234567890"), 5*time.Second)
	if err != nil {
		t.Fatalf("overwrite within capacity should succeed: %v", err)
	}

	data, _ := store.Get("key")
	if string(data) != "1234567890" {
		t.Fatalf("data = %q, want %q", data, "1234567890")
	}
}

func TestCapacityLimitOverwriteTooLarge(t *testing.T) {
	store := newTestStore(10)
	defer store.Close()

	store.Put("key", []byte("12345"), 5*time.Second) // 5 bytes

	// Overwrite with value that exceeds capacity (old 5 subtracted, new 11 added = 11 > 10)
	err := store.Put("key", []byte("12345678901"), 5*time.Second)
	if err != ErrStoreFull {
		t.Fatalf("overwrite exceeding capacity should return ErrStoreFull, got: %v", err)
	}

	// Original value should be preserved
	data, _ := store.Get("key")
	if string(data) != "12345" {
		t.Fatalf("original data should be preserved after rejected overwrite, got %q", data)
	}
}

func TestCapacityUnlimited(t *testing.T) {
	store := newTestStore(0) // 0 = unlimited
	defer store.Close()

	// Should accept any amount of data
	bigData := make([]byte, 1024*1024) // 1MB
	err := store.Put("big", bigData, 5*time.Second)
	if err != nil {
		t.Fatalf("unlimited store should accept any size: %v", err)
	}
}

func TestCapacityFreedAfterExpiration(t *testing.T) {
	store := newTestStore(10)
	defer store.Close()

	store.Put("temp", []byte("1234567890"), 50*time.Millisecond) // fills capacity
	time.Sleep(100 * time.Millisecond)

	// Manually trigger cleanup (don't wait for the 30s worker)
	store.cleanupExpired()

	// Capacity should be freed
	err := store.Put("new", []byte("1234567890"), 5*time.Second)
	if err != nil {
		t.Fatalf("write should succeed after expired data is cleaned up: %v", err)
	}
}

func TestCapacityTracksOverwrites(t *testing.T) {
	store := newTestStore(20)
	defer store.Close()

	store.Put("a", []byte("1234567890"), 5*time.Second) // 10 bytes
	store.Put("a", []byte("12345"), 5*time.Second)      // shrinks to 5 bytes

	// Should have 15 bytes free, so this 15-byte write should succeed
	err := store.Put("b", []byte("123456789012345"), 5*time.Second)
	if err != nil {
		t.Fatalf("write should succeed after overwrite freed space: %v", err)
	}
}

// --- Concurrency tests ---

func TestConcurrentReadWrite(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	var wg sync.WaitGroup
	const goroutines = 50
	const iterations = 100

	// Concurrent writers
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				key := "key"
				store.Put(key, []byte("data"), 5*time.Second)
			}
		}(i)
	}

	// Concurrent readers
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				store.Get("key")
				store.GetWithMetadata("key")
				store.Scan()
			}
		}()
	}

	wg.Wait()
}

func TestConcurrentReadWithExpiration(t *testing.T) {
	store := newTestStore(0)
	defer store.Close()

	// Write keys that will expire during concurrent reads
	for i := 0; i < 100; i++ {
		store.Put("key", []byte("data"), 10*time.Millisecond)
	}

	var wg sync.WaitGroup
	const goroutines = 50

	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				store.Get("key")
				store.GetWithMetadata("key")
			}
		}()
	}

	wg.Wait()
	// If we get here without a race detector panic, the fix for #8 is working
}
