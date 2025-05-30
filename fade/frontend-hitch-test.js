#!/usr/bin/env node

const http = require('http');

class FrontendHitchTester {
    constructor() {
        this.proxyUrl = 'http://localhost:3000';
        this.results = [];
    }

    async makeRequest(url, options, data) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const req = http.request(url, options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    const endTime = Date.now();
                    resolve({
                        statusCode: res.statusCode,
                        responseTime: endTime - startTime,
                        body,
                        headers: res.headers
                    });
                });
            });

            req.on('error', (error) => {
                const endTime = Date.now();
                reject({
                    error: error.message,
                    responseTime: endTime - startTime
                });
            });

            req.on('timeout', () => {
                req.destroy();
                const endTime = Date.now();
                reject({
                    error: 'Request timeout',
                    responseTime: endTime - startTime
                });
            });

            if (data) {
                req.write(data);
            }
            req.end();
        });
    }

    // Test 1: Rapid fire submissions (like fast clicking)
    async testRapidFireSubmissions() {
        console.log('\n🔥 Test 1: Rapid Fire Submissions (simulating fast clicking)');
        
        const results = [];
        const messageCount = 20;
        
        console.log(`Sending ${messageCount} messages as fast as possible...`);
        
        for (let i = 0; i < messageCount; i++) {
            const key = `rapid-${i}-${Date.now()}`;
            const message = `Rapid fire message ${i}`;
            const dataBytes = Buffer.from(message).toString('base64');
            
            const data = JSON.stringify({
                data: dataBytes,
                ttl: 300
            });
            
            try {
                const result = await this.makeRequest(`${this.proxyUrl}/api/data/${key}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data)
                    },
                    timeout: 5000
                }, data);
                
                results.push({
                    messageId: i,
                    responseTime: result.responseTime,
                    success: true
                });
                
                // No delay - rapid fire!
                
            } catch (error) {
                results.push({
                    messageId: i,
                    responseTime: error.responseTime,
                    success: false,
                    error: error.error
                });
            }
        }
        
        this.analyzeHitchPatterns(results, 'Rapid Fire');
    }

    // Test 2: Large payloads that might cause buffering issues
    async testLargePayloads() {
        console.log('\n📦 Test 2: Large Payload Submissions');
        
        const results = [];
        const messageSizes = [1000, 5000, 10000, 50000]; // Different payload sizes
        
        for (const size of messageSizes) {
            const key = `large-${size}-${Date.now()}`;
            const message = 'X'.repeat(size); // Create message of specified size
            const dataBytes = Buffer.from(message).toString('base64');
            
            const data = JSON.stringify({
                data: dataBytes,
                ttl: 300
            });
            
            console.log(`Testing ${size} byte payload...`);
            
            try {
                const result = await this.makeRequest(`${this.proxyUrl}/api/data/${key}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data)
                    },
                    timeout: 10000
                }, data);
                
                results.push({
                    payloadSize: size,
                    responseTime: result.responseTime,
                    success: true
                });
                
                console.log(`  ✅ ${size} bytes: ${result.responseTime}ms`);
                
            } catch (error) {
                results.push({
                    payloadSize: size,
                    responseTime: error.responseTime,
                    success: false,
                    error: error.error
                });
                
                console.log(`  ❌ ${size} bytes: ${error.responseTime}ms - ${error.error}`);
            }
        }
        
        this.analyzePayloadPerformance(results);
    }

    // Test 3: Concurrent submissions from multiple "users"
    async testConcurrentUsers() {
        console.log('\n👥 Test 3: Concurrent Users (simulating multiple browser tabs)');
        
        const userCount = 10;
        const messagesPerUser = 5;
        
        const userPromises = Array(userCount).fill(0).map(async (_, userId) => {
            const userResults = [];
            
            for (let msgId = 0; msgId < messagesPerUser; msgId++) {
                const key = `user-${userId}-msg-${msgId}-${Date.now()}`;
                const message = `Message from user ${userId}, message ${msgId}`;
                const dataBytes = Buffer.from(message).toString('base64');
                
                const data = JSON.stringify({
                    data: dataBytes,
                    ttl: 300
                });
                
                try {
                    const result = await this.makeRequest(`${this.proxyUrl}/api/data/${key}`, {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(data)
                        },
                        timeout: 5000
                    }, data);
                    
                    userResults.push({
                        userId,
                        messageId: msgId,
                        responseTime: result.responseTime,
                        success: true
                    });
                    
                } catch (error) {
                    userResults.push({
                        userId,
                        messageId: msgId,
                        responseTime: error.responseTime,
                        success: false,
                        error: error.error
                    });
                }
                
                // Small random delay to simulate human behavior
                await new Promise(resolve => setTimeout(resolve, Math.random() * 200));
            }
            
            return userResults;
        });
        
        const allUserResults = await Promise.all(userPromises);
        const flatResults = allUserResults.flat();
        
        this.analyzeHitchPatterns(flatResults, 'Concurrent Users');
    }

    // Test 4: Mixed operations (submit + scan)
    async testMixedOperations() {
        console.log('\n🔄 Test 4: Mixed Operations (submit + scan, simulating real usage)');
        
        const results = [];
        const operationCount = 30;
        
        for (let i = 0; i < operationCount; i++) {
            if (i % 3 === 0) {
                // Scan operation
                try {
                    const result = await this.makeRequest(`${this.proxyUrl}/api/scan`, {
                        method: 'GET',
                        timeout: 5000
                    });
                    
                    const keys = JSON.parse(result.body).keys || [];
                    results.push({
                        operation: 'scan',
                        responseTime: result.responseTime,
                        success: true,
                        keyCount: keys.length
                    });
                    
                } catch (error) {
                    results.push({
                        operation: 'scan',
                        responseTime: error.responseTime,
                        success: false,
                        error: error.error
                    });
                }
            } else {
                // Submit operation
                const key = `mixed-${i}-${Date.now()}`;
                const message = `Mixed operation message ${i}`;
                const dataBytes = Buffer.from(message).toString('base64');
                
                const data = JSON.stringify({
                    data: dataBytes,
                    ttl: 300
                });
                
                try {
                    const result = await this.makeRequest(`${this.proxyUrl}/api/data/${key}`, {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(data)
                        },
                        timeout: 5000
                    }, data);
                    
                    results.push({
                        operation: 'submit',
                        responseTime: result.responseTime,
                        success: true
                    });
                    
                } catch (error) {
                    results.push({
                        operation: 'submit',
                        responseTime: error.responseTime,
                        success: false,
                        error: error.error
                    });
                }
            }
            
            // Small delay
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        this.analyzeMixedOperations(results);
    }

    // Test 5: Network condition simulation
    async testWithNetworkConditions() {
        console.log('\n🌐 Test 5: Network Condition Simulation');
        
        const results = [];
        
        // Test with different timeouts to simulate network conditions
        const timeouts = [1000, 2000, 5000, 10000];
        
        for (const timeout of timeouts) {
            console.log(`Testing with ${timeout}ms timeout...`);
            
            const key = `network-test-${timeout}-${Date.now()}`;
            const message = `Network test with ${timeout}ms timeout`;
            const dataBytes = Buffer.from(message).toString('base64');
            
            const data = JSON.stringify({
                data: dataBytes,
                ttl: 300
            });
            
            try {
                const result = await this.makeRequest(`${this.proxyUrl}/api/data/${key}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data)
                    },
                    timeout: timeout
                }, data);
                
                results.push({
                    timeout,
                    responseTime: result.responseTime,
                    success: true
                });
                
                console.log(`  ✅ ${timeout}ms timeout: ${result.responseTime}ms`);
                
            } catch (error) {
                results.push({
                    timeout,
                    responseTime: error.responseTime,
                    success: false,
                    error: error.error
                });
                
                console.log(`  ❌ ${timeout}ms timeout: ${error.responseTime}ms - ${error.error}`);
            }
        }
    }

    analyzeHitchPatterns(results, testName) {
        console.log(`\n📊 ${testName} Analysis:`);
        
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        
        console.log(`Total: ${results.length}, Successful: ${successful.length}, Failed: ${failed.length}`);
        
        if (successful.length > 0) {
            const times = successful.map(r => r.responseTime);
            const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
            const maxTime = Math.max(...times);
            const minTime = Math.min(...times);
            
            console.log(`Response times - Avg: ${avgTime.toFixed(0)}ms, Min: ${minTime}ms, Max: ${maxTime}ms`);
            
            // Look for hitches (sudden spikes)
            const threshold = avgTime * 3; // 3x average is considered a hitch
            const hitches = successful.filter(r => r.responseTime > threshold);
            
            if (hitches.length > 0) {
                console.log(`⚠️  Detected ${hitches.length} hitches (>3x avg response time):`);
                hitches.forEach(hitch => {
                    const msgId = hitch.messageId !== undefined ? `msg ${hitch.messageId}` : `user ${hitch.userId}`;
                    console.log(`  - ${msgId}: ${hitch.responseTime}ms`);
                });
            } else {
                console.log(`✅ No significant hitches detected`);
            }
            
            // Look for progressive slowdown
            if (successful.length >= 5) {
                const firstFive = times.slice(0, 5);
                const lastFive = times.slice(-5);
                const firstAvg = firstFive.reduce((a, b) => a + b, 0) / firstFive.length;
                const lastAvg = lastFive.reduce((a, b) => a + b, 0) / lastFive.length;
                
                if (lastAvg > firstAvg * 1.5) {
                    console.log(`⚠️  Progressive slowdown detected: ${firstAvg.toFixed(0)}ms -> ${lastAvg.toFixed(0)}ms`);
                }
            }
        }
        
        if (failed.length > 0) {
            console.log(`❌ Failures detected - this could cause frontend freezing!`);
        }
    }

    analyzePayloadPerformance(results) {
        console.log(`\n📊 Payload Size Performance:`);
        
        results.forEach(result => {
            if (result.success) {
                const throughput = (result.payloadSize / result.responseTime) * 1000; // bytes per second
                console.log(`  ${result.payloadSize} bytes: ${result.responseTime}ms (${(throughput/1024).toFixed(1)} KB/s)`);
            } else {
                console.log(`  ${result.payloadSize} bytes: FAILED - ${result.error}`);
            }
        });
        
        // Check if larger payloads cause disproportional slowdown
        const successful = results.filter(r => r.success);
        if (successful.length >= 2) {
            const smallest = successful[0];
            const largest = successful[successful.length - 1];
            const sizeRatio = largest.payloadSize / smallest.payloadSize;
            const timeRatio = largest.responseTime / smallest.responseTime;
            
            if (timeRatio > sizeRatio * 2) {
                console.log(`⚠️  Large payloads show disproportional slowdown: ${sizeRatio}x size -> ${timeRatio.toFixed(1)}x time`);
            }
        }
    }

    analyzeMixedOperations(results) {
        console.log(`\n📊 Mixed Operations Analysis:`);
        
        const submitResults = results.filter(r => r.operation === 'submit');
        const scanResults = results.filter(r => r.operation === 'scan');
        
        if (submitResults.length > 0) {
            const submitTimes = submitResults.filter(r => r.success).map(r => r.responseTime);
            const submitAvg = submitTimes.reduce((a, b) => a + b, 0) / submitTimes.length;
            console.log(`Submit operations: ${submitResults.length} total, avg ${submitAvg.toFixed(0)}ms`);
        }
        
        if (scanResults.length > 0) {
            const scanTimes = scanResults.filter(r => r.success).map(r => r.responseTime);
            const scanAvg = scanTimes.reduce((a, b) => a + b, 0) / scanTimes.length;
            console.log(`Scan operations: ${scanResults.length} total, avg ${scanAvg.toFixed(0)}ms`);
        }
        
        // Check if scans are interfering with submits
        const successful = results.filter(r => r.success);
        for (let i = 1; i < successful.length; i++) {
            const prev = successful[i-1];
            const curr = successful[i];
            
            if (prev.operation === 'scan' && curr.operation === 'submit' && 
                curr.responseTime > prev.responseTime * 2) {
                console.log(`⚠️  Possible scan interference: scan ${prev.responseTime}ms -> submit ${curr.responseTime}ms`);
            }
        }
    }

    async runAllTests() {
        console.log('🔍 Frontend Hitch Detection Test Suite');
        console.log('This test simulates conditions that might cause browser UI hitches\n');
        
        try {
            await this.testRapidFireSubmissions();
            await this.testLargePayloads();
            await this.testConcurrentUsers();
            await this.testMixedOperations();
            await this.testWithNetworkConditions();
            
            console.log('\n' + '='.repeat(60));
            console.log('🎯 FRONTEND HITCH TEST SUMMARY');
            console.log('='.repeat(60));
            console.log('✅ All tests completed!');
            console.log('\n💡 If you\'re still experiencing hitches, they may be caused by:');
            console.log('   - Frontend JavaScript blocking the UI thread');
            console.log('   - Browser network throttling');
            console.log('   - Memory pressure from accumulating DOM elements');
            console.log('   - CSS animations or rendering issues');
            console.log('   - Browser developer tools being open');
            
        } catch (error) {
            console.error('❌ Test failed:', error.message);
        }
    }
}

// Run the tests
const tester = new FrontendHitchTester();
tester.runAllTests().catch(console.error);