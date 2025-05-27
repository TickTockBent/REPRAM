package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

type LoadTester struct {
	baseURL     string
	concurrency int
	duration    time.Duration
	keyPrefix   string
	dataSize    int
	
	// Metrics
	totalRequests   int64
	successfulReqs  int64
	failedRequests  int64
	totalLatency    int64
	minLatency      int64
	maxLatency      int64
	
	// HTTP client
	client *http.Client
}

type PutRequest struct {
	Data []byte `json:"data"`
	TTL  int    `json:"ttl"`
}

type TestResult struct {
	TotalRequests    int64         `json:"total_requests"`
	SuccessfulReqs   int64         `json:"successful_requests"`
	FailedRequests   int64         `json:"failed_requests"`
	RequestsPerSec   float64       `json:"requests_per_second"`
	AvgLatency       time.Duration `json:"avg_latency_ms"`
	MinLatency       time.Duration `json:"min_latency_ms"`
	MaxLatency       time.Duration `json:"max_latency_ms"`
	SuccessRate      float64       `json:"success_rate"`
	TestDuration     time.Duration `json:"test_duration"`
}

func NewLoadTester(baseURL string, concurrency int, duration time.Duration, keyPrefix string, dataSize int) *LoadTester {
	return &LoadTester{
		baseURL:     baseURL,
		concurrency: concurrency,
		duration:    duration,
		keyPrefix:   keyPrefix,
		dataSize:    dataSize,
		minLatency:  int64(^uint64(0) >> 1), // Max int64
		client: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 100,
				IdleConnTimeout:     90 * time.Second,
			},
		},
	}
}

func (lt *LoadTester) generateData() []byte {
	data := make([]byte, lt.dataSize)
	for i := range data {
		data[i] = byte(rand.Intn(256))
	}
	return data
}

func (lt *LoadTester) putData(key string, data []byte, ttl int) error {
	reqBody := PutRequest{
		Data: data,
		TTL:  ttl,
	}
	
	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return err
	}
	
	req, err := http.NewRequest("PUT", fmt.Sprintf("%s/data/%s", lt.baseURL, key), bytes.NewBuffer(jsonData))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	
	start := time.Now()
	resp, err := lt.client.Do(req)
	latency := time.Since(start).Nanoseconds()
	
	atomic.AddInt64(&lt.totalRequests, 1)
	atomic.AddInt64(&lt.totalLatency, latency)
	
	// Update min/max latency
	for {
		current := atomic.LoadInt64(&lt.minLatency)
		if latency >= current || atomic.CompareAndSwapInt64(&lt.minLatency, current, latency) {
			break
		}
	}
	
	for {
		current := atomic.LoadInt64(&lt.maxLatency)
		if latency <= current || atomic.CompareAndSwapInt64(&lt.maxLatency, current, latency) {
			break
		}
	}
	
	if err != nil {
		atomic.AddInt64(&lt.failedRequests, 1)
		return err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusCreated {
		atomic.AddInt64(&lt.failedRequests, 1)
		return fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}
	
	atomic.AddInt64(&lt.successfulReqs, 1)
	return nil
}

func (lt *LoadTester) getData(key string) error {
	start := time.Now()
	resp, err := lt.client.Get(fmt.Sprintf("%s/data/%s", lt.baseURL, key))
	latency := time.Since(start).Nanoseconds()
	
	atomic.AddInt64(&lt.totalRequests, 1)
	atomic.AddInt64(&lt.totalLatency, latency)
	
	// Update min/max latency
	for {
		current := atomic.LoadInt64(&lt.minLatency)
		if latency >= current || atomic.CompareAndSwapInt64(&lt.minLatency, current, latency) {
			break
		}
	}
	
	for {
		current := atomic.LoadInt64(&lt.maxLatency)
		if latency <= current || atomic.CompareAndSwapInt64(&lt.maxLatency, current, latency) {
			break
		}
	}
	
	if err != nil {
		atomic.AddInt64(&lt.failedRequests, 1)
		return err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		atomic.AddInt64(&lt.failedRequests, 1)
		return fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}
	
	// Consume response body
	io.Copy(io.Discard, resp.Body)
	
	atomic.AddInt64(&lt.successfulReqs, 1)
	return nil
}

func (lt *LoadTester) worker(stopCh <-chan struct{}, wg *sync.WaitGroup) {
	defer wg.Done()
	
	for {
		select {
		case <-stopCh:
			return
		default:
			// Randomly choose between PUT and GET (70% PUT, 30% GET)
			if rand.Float32() < 0.7 {
				key := fmt.Sprintf("%s-%d-%d", lt.keyPrefix, rand.Intn(1000), time.Now().UnixNano())
				data := lt.generateData()
				ttl := rand.Intn(300) + 60 // TTL between 60-360 seconds
				lt.putData(key, data, ttl)
			} else {
				key := fmt.Sprintf("%s-%d-%d", lt.keyPrefix, rand.Intn(1000), time.Now().UnixNano()-int64(rand.Intn(60000000000))) // Recent key
				lt.getData(key)
			}
		}
	}
}

func (lt *LoadTester) Run() TestResult {
	fmt.Printf("Starting load test:\n")
	fmt.Printf("  Target: %s\n", lt.baseURL)
	fmt.Printf("  Concurrency: %d\n", lt.concurrency)
	fmt.Printf("  Duration: %s\n", lt.duration)
	fmt.Printf("  Data size: %d bytes\n", lt.dataSize)
	fmt.Printf("  Key prefix: %s\n", lt.keyPrefix)
	fmt.Printf("\n")
	
	stopCh := make(chan struct{})
	var wg sync.WaitGroup
	
	start := time.Now()
	
	// Start workers
	for i := 0; i < lt.concurrency; i++ {
		wg.Add(1)
		go lt.worker(stopCh, &wg)
	}
	
	// Progress reporting
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		
		for {
			select {
			case <-stopCh:
				return
			case <-ticker.C:
				elapsed := time.Since(start)
				requests := atomic.LoadInt64(&lt.totalRequests)
				successful := atomic.LoadInt64(&lt.successfulReqs)
				failed := atomic.LoadInt64(&lt.failedRequests)
				
				fmt.Printf("Progress: %s elapsed, %d requests (%d successful, %d failed), %.2f req/sec\n",
					elapsed.Round(time.Second),
					requests,
					successful,
					failed,
					float64(requests)/elapsed.Seconds())
			}
		}
	}()
	
	// Wait for test duration
	time.Sleep(lt.duration)
	close(stopCh)
	wg.Wait()
	
	actualDuration := time.Since(start)
	
	// Calculate results
	totalRequests := atomic.LoadInt64(&lt.totalRequests)
	successfulReqs := atomic.LoadInt64(&lt.successfulReqs)
	failedRequests := atomic.LoadInt64(&lt.failedRequests)
	totalLatency := atomic.LoadInt64(&lt.totalLatency)
	minLatency := atomic.LoadInt64(&lt.minLatency)
	maxLatency := atomic.LoadInt64(&lt.maxLatency)
	
	var avgLatency time.Duration
	if totalRequests > 0 {
		avgLatency = time.Duration(totalLatency / totalRequests)
	}
	
	result := TestResult{
		TotalRequests:  totalRequests,
		SuccessfulReqs: successfulReqs,
		FailedRequests: failedRequests,
		RequestsPerSec: float64(totalRequests) / actualDuration.Seconds(),
		AvgLatency:     avgLatency,
		MinLatency:     time.Duration(minLatency),
		MaxLatency:     time.Duration(maxLatency),
		SuccessRate:    float64(successfulReqs) / float64(totalRequests) * 100,
		TestDuration:   actualDuration,
	}
	
	return result
}

func (lt *LoadTester) PrintResults(result TestResult) {
	fmt.Printf("\n=== Load Test Results ===\n")
	fmt.Printf("Test Duration: %s\n", result.TestDuration.Round(time.Millisecond))
	fmt.Printf("Total Requests: %d\n", result.TotalRequests)
	fmt.Printf("Successful Requests: %d\n", result.SuccessfulReqs)
	fmt.Printf("Failed Requests: %d\n", result.FailedRequests)
	fmt.Printf("Requests/sec: %.2f\n", result.RequestsPerSec)
	fmt.Printf("Success Rate: %.2f%%\n", result.SuccessRate)
	fmt.Printf("Average Latency: %s\n", result.AvgLatency.Round(time.Microsecond))
	fmt.Printf("Min Latency: %s\n", result.MinLatency.Round(time.Microsecond))
	fmt.Printf("Max Latency: %s\n", result.MaxLatency.Round(time.Microsecond))
	
	// JSON output for automated processing
	fmt.Printf("\n=== JSON Results ===\n")
	jsonResult, _ := json.MarshalIndent(result, "", "  ")
	fmt.Printf("%s\n", jsonResult)
}

func main() {
	var (
		baseURL     = flag.String("url", "http://localhost:8080", "Base URL of REPRAM node")
		concurrency = flag.Int("c", 10, "Number of concurrent workers")
		duration    = flag.Duration("d", 60*time.Second, "Test duration")
		keyPrefix   = flag.String("prefix", "loadtest", "Key prefix for test data")
		dataSize    = flag.Int("size", 1024, "Size of test data in bytes")
	)
	flag.Parse()
	
	rand.Seed(time.Now().UnixNano())
	
	tester := NewLoadTester(*baseURL, *concurrency, *duration, *keyPrefix, *dataSize)
	result := tester.Run()
	tester.PrintResults(result)
}