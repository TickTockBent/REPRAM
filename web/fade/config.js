// Configuration for FADE demo
const FadeConfig = {
    // API endpoint configuration
    getApiBaseURL: function() {
        // Check URL parameters first
        const urlParams = new URLSearchParams(window.location.search);
        const backend = urlParams.get('backend');
        if (backend) {
            console.log('Using backend from URL parameter:', backend);
            return backend;
        }
        
        // Check localStorage for saved backend
        const savedBackend = localStorage.getItem('fade_backend_url');
        if (savedBackend) {
            console.log('Using saved backend:', savedBackend);
            return savedBackend;
        }
        
        // Default backends based on environment
        if (window.location.hostname === 'fade.repram.io' || window.location.hostname === 'repram.io') {
            // Production - use your dynamic DNS (HTTP for now, HTTPS later)
            return 'http://repram.ddns.net:8081';
        } else if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || 
                   window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.') || 
                   window.location.hostname.startsWith('172.')) {
            // Local development (localhost or private IP ranges) - use same hostname
            return `http://${window.location.hostname}:8081`;
        }
        
        // Fallback to same origin
        return '';
    },
    
    // Node endpoints (for direct connection)
    getNodes: function() {
        if (window.location.hostname === 'fade.repram.io' || window.location.hostname === 'repram.io') {
            return [
                'http://repram.ddns.net:8081',
                'http://repram.ddns.net:8082', 
                'http://repram.ddns.net:8083'
            ];
        } else {
            // Local development - use same hostname as the web server
            const hostname = window.location.hostname;
            return [
                `http://${hostname}:8081`,
                `http://${hostname}:8082`, 
                `http://${hostname}:8083`
            ];
        }
    },
    
    // Connection mode
    connectionMode: 'direct', // 'direct' to connect to nodes, 'proxy' to use fade server
};

// Helper to set custom backend
window.setFadeBackend = function(url) {
    localStorage.setItem('fade_backend_url', url);
    console.log('Backend URL saved. Reload the page to use:', url);
};