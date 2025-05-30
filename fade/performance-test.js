#!/usr/bin/env node

const http = require('http');
const https = require('https');

class PerformanceTester {
    constructor() {
        this.results = [];
        this.nodeUrls = [
            'http://localhost:8080',
            'http://localhost:8081', 
            'http://localhost:8082'
        ];
        this.proxyUrl = 'http://localhost:3000';
        this.currentNodeIndex = 0;
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

    async testDirectNodeAccess() {
        console.log('\n🔍 Testing direct node access...');
        
        for (const nodeUrl of this.nodeUrls) {
            const startTime = Date.now();
            try {
                const result = await this.makeRequest(`${nodeUrl}/health`, {
                    method: 'GET',
                    timeout: 5000
                });
                console.log(`✅ ${nodeUrl}: ${result.responseTime}ms (${result.statusCode})`);
            } catch (error) {
                console.log(`❌ ${nodeUrl}: ${error.responseTime}ms - ${error.error}`);
            }
        }
    }

    async testProxyAccess() {
        console.log('\n🔍 Testing proxy access...');
        
        for (let i = 0; i < 3; i++) {
            const nodePort = 8080 + i;
            try {
                const result = await this.makeRequest(`${this.proxyUrl}/api/health?preferred=${nodePort}`, {
                    method: 'GET',
                    timeout: 5000
                });
                console.log(`✅ Proxy -> Node ${nodePort}: ${result.responseTime}ms (${result.statusCode})`);
            } catch (error) {
                console.log(`❌ Proxy -> Node ${nodePort}: ${error.responseTime}ms - ${error.error}`);
            }
        }
    }

    async testMessageSubmission(count = 50, concurrency = 5) {
        console.log(`\n🚀 Testing message submission: ${count} messages, ${concurrency} concurrent...`);
        
        const results = [];
        const errors = [];
        
        for (let i = 0; i < count; i += concurrency) {
            const batch = [];
            const batchSize = Math.min(concurrency, count - i);
            
            for (let j = 0; j < batchSize; j++) {
                const messageId = i + j + 1;
                const nodePort = 8080 + (messageId % 3);
                
                batch.push(this.submitMessage(messageId, nodePort));
            }
            
            const batchResults = await Promise.allSettled(batch);
            
            batchResults.forEach((result, index) => {
                const messageId = i + index + 1;
                if (result.status === 'fulfilled') {
                    results.push({
                        messageId,
                        ...result.value
                    });
                } else {
                    errors.push({
                        messageId,
                        error: result.reason
                    });
                }
            });
            
            // Progress indicator
            process.stdout.write(`\r📊 Progress: ${Math.min(i + batchSize, count)}/${count} messages`);
            
            // Small delay to simulate real usage
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        console.log('\n');
        this.analyzeResults(results, errors);
    }

    async submitMessage(messageId, nodePort) {
        const key = `perf-test-${messageId}-${Date.now()}`;
        const message = `Performance test message ${messageId} at ${new Date().toISOString()}`;
        const dataBytes = Buffer.from(message).toString('base64');
        
        const data = JSON.stringify({
            data: dataBytes,
            ttl: 300
        });
        
        try {
            const result = await this.makeRequest(`${this.proxyUrl}/api/data/${key}?preferred=${nodePort}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                },
                timeout: 10000
            }, data);
            
            return {
                success: true,
                responseTime: result.responseTime,
                statusCode: result.statusCode,
                nodePort
            };
        } catch (error) {
            return {
                success: false,
                responseTime: error.responseTime || 0,
                error: error.error,
                nodePort
            };
        }
    }

    analyzeResults(results, errors) {
        console.log('\n📈 Performance Analysis:');
        console.log(`Total Requests: ${results.length + errors.length}`);
        console.log(`Successful: ${results.length}`);
        console.log(`Failed: ${errors.length}`);
        
        if (results.length > 0) {
            const responseTimes = results.map(r => r.responseTime);
            const avgTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
            const sortedTimes = responseTimes.sort((a, b) => a - b);
            const p50 = sortedTimes[Math.floor(sortedTimes.length * 0.5)];
            const p95 = sortedTimes[Math.floor(sortedTimes.length * 0.95)];
            const p99 = sortedTimes[Math.floor(sortedTimes.length * 0.99)];
            const maxTime = Math.max(...responseTimes);
            
            console.log(`\nResponse Times:`);
            console.log(`  Average: ${avgTime.toFixed(0)}ms`);
            console.log(`  P50: ${p50}ms`);
            console.log(`  P95: ${p95}ms`);
            console.log(`  P99: ${p99}ms`);
            console.log(`  Max: ${maxTime}ms`);
            
            // Identify slow requests
            const slowRequests = results.filter(r => r.responseTime > 1000);
            if (slowRequests.length > 0) {
                console.log(`\n⚠️  Slow Requests (>1s): ${slowRequests.length}`);
                slowRequests.slice(0, 5).forEach(req => {
                    console.log(`  - Message ${req.messageId}: ${req.responseTime}ms (node ${req.nodePort})`);
                });
            }
            
            // Very slow requests
            const verySlow = results.filter(r => r.responseTime > 2000);
            if (verySlow.length > 0) {
                console.log(`\n🐌 Very Slow Requests (>2s): ${verySlow.length}`);
                verySlow.forEach(req => {
                    console.log(`  - Message ${req.messageId}: ${req.responseTime}ms (node ${req.nodePort})`);
                });
            }
            
            // Node performance comparison
            const nodeStats = {};
            [8080, 8081, 8082].forEach(port => {
                const nodeResults = results.filter(r => r.nodePort === port);
                if (nodeResults.length > 0) {
                    const nodeTimes = nodeResults.map(r => r.responseTime);
                    const nodeAvg = nodeTimes.reduce((a, b) => a + b, 0) / nodeTimes.length;
                    nodeStats[port] = {
                        count: nodeResults.length,
                        avgTime: nodeAvg,
                        maxTime: Math.max(...nodeTimes)
                    };
                }
            });
            
            console.log(`\n🏆 Node Performance:`);
            Object.entries(nodeStats).forEach(([port, stats]) => {
                console.log(`  Node ${port}: ${stats.count} requests, avg ${stats.avgTime.toFixed(0)}ms, max ${stats.maxTime}ms`);
            });
        }
        
        if (errors.length > 0) {
            console.log(`\n❌ Errors:`);
            const errorGroups = {};
            errors.forEach(error => {
                const errorType = error.error.error || error.error;
                errorGroups[errorType] = (errorGroups[errorType] || 0) + 1;
            });
            
            Object.entries(errorGroups).forEach(([errorType, count]) => {
                console.log(`  ${errorType}: ${count} occurrences`);
            });
        }
    }

    async testScanPerformance() {
        console.log('\n🔍 Testing scan endpoint performance...');
        
        // First add some data
        console.log('Adding test data...');
        for (let i = 0; i < 10; i++) {
            await this.submitMessage(i, 8080 + (i % 3));
        }
        
        // Wait a moment for replication
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Test scan performance on each node
        for (let nodePort = 8080; nodePort <= 8082; nodePort++) {
            try {
                const result = await this.makeRequest(`${this.proxyUrl}/api/scan?preferred=${nodePort}`, {
                    method: 'GET',
                    timeout: 5000
                });
                
                const keys = JSON.parse(result.body).keys || [];
                console.log(`✅ Node ${nodePort} scan: ${result.responseTime}ms, ${keys.length} keys`);
            } catch (error) {
                console.log(`❌ Node ${nodePort} scan: ${error.responseTime}ms - ${error.error}`);
            }
        }
    }

    async testConcurrentLoad() {
        console.log('\n⚡ Testing high concurrency load (simulating frontend hitches)...');
        
        const concurrency = 20;
        const duration = 10000; // 10 seconds
        const startTime = Date.now();
        let messageId = 1;
        const allResults = [];
        
        console.log(`Running ${concurrency} concurrent streams for ${duration/1000} seconds...`);
        
        const workers = Array(concurrency).fill(0).map(async (_, workerIndex) => {
            const workerResults = [];
            
            while (Date.now() - startTime < duration) {
                const myMessageId = messageId++;
                const nodePort = 8080 + (myMessageId % 3);
                
                try {
                    const result = await this.submitMessage(myMessageId, nodePort);
                    workerResults.push({
                        workerId: workerIndex,
                        messageId: myMessageId,
                        ...result
                    });
                    
                    // Brief pause to prevent overwhelming
                    await new Promise(resolve => setTimeout(resolve, 50));
                } catch (error) {
                    workerResults.push({
                        workerId: workerIndex,
                        messageId: myMessageId,
                        success: false,
                        error: error.message
                    });
                }
            }
            
            return workerResults;
        });
        
        const allWorkerResults = await Promise.all(workers);
        const flatResults = allWorkerResults.flat();
        const successful = flatResults.filter(r => r.success);
        const failed = flatResults.filter(r => !r.success);
        
        console.log(`\n📊 Concurrent Load Results:`);
        console.log(`Total requests: ${flatResults.length}`);
        console.log(`Successful: ${successful.length}`);
        console.log(`Failed: ${failed.length}`);
        console.log(`Success rate: ${((successful.length / flatResults.length) * 100).toFixed(1)}%`);
        
        if (successful.length > 0) {
            const times = successful.map(r => r.responseTime);
            const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
            const maxTime = Math.max(...times);
            const slowCount = times.filter(t => t > 1000).length;
            
            console.log(`Average response time: ${avgTime.toFixed(0)}ms`);
            console.log(`Max response time: ${maxTime}ms`);
            console.log(`Slow requests (>1s): ${slowCount}`);
            
            if (slowCount > 0) {
                console.log('⚠️  High concurrency is causing slow responses!');
            }
        }
        
        return { successful, failed, flatResults };
    }

    async runFullTest() {
        console.log('🚀 Starting comprehensive performance test...\n');
        
        try {
            await this.testDirectNodeAccess();
            await this.testProxyAccess();
            await this.testScanPerformance();
            await this.testMessageSubmission(30, 3);
            
            console.log('\n' + '='.repeat(60));
            console.log('🎯 HIGH CONCURRENCY TEST (this may reveal hitches)');
            console.log('='.repeat(60));
            
            await this.testConcurrentLoad();
            
            console.log('\n✅ Performance test completed!');
            console.log('\n💡 Check the results above for bottlenecks and performance issues.');
            
        } catch (error) {
            console.error('❌ Test failed:', error.message);
        }
    }
}

// Run the test
const tester = new PerformanceTester();
tester.runFullTest().catch(console.error);