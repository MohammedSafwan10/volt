document.addEventListener('DOMContentLoaded', () => {
    // Theme Toggle Logic
    const themeToggle = document.getElementById('theme-toggle');
    const htmlElement = document.documentElement;
    const savedTheme = localStorage.getItem('theme') || 'dark';
    htmlElement.setAttribute('data-theme', savedTheme);

    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            const currentTheme = htmlElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            htmlElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
        });
    }

    // Scroll Progress Bar
    const progressBar = document.querySelector('.scroll-progress');
    window.addEventListener('scroll', () => {
        const winScroll = document.body.scrollTop || document.documentElement.scrollTop;
        const height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
        const scrolled = (winScroll / height) * 100;
        if (progressBar) progressBar.style.width = scrolled + "%";
    });

    // Custom Cursor Logic
    const cursor = document.querySelector('.cursor');
    const follower = document.querySelector('.cursor-follower');
    let mouseX = 0, mouseY = 0;
    let posX = 0, posY = 0;

    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });

    function animateCursor() {
        posX += (mouseX - posX) / 6;
        posY += (mouseY - posY) / 6;
        if (cursor) cursor.style.transform = `translate3d(${mouseX}px, ${mouseY}px, 0)`;
        if (follower) follower.style.transform = `translate3d(${posX - 10}px, ${posY - 10}px, 0)`;
        requestAnimationFrame(animateCursor);
    }
    animateCursor();

    // Magnetic Buttons
    const magneticElements = document.querySelectorAll('.magnetic');
    magneticElements.forEach(el => {
        el.addEventListener('mousemove', (e) => {
            const rect = el.getBoundingClientRect();
            const x = e.clientX - rect.left - rect.width / 2;
            const y = e.clientY - rect.top - rect.height / 2;
            el.style.transform = `translate(${x * 0.3}px, ${y * 0.5}px)`;
        });
        el.addEventListener('mouseleave', () => {
            el.style.transform = `translate(0px, 0px)`;
        });
    });

    // Hover effect for follower
    const hoverables = document.querySelectorAll('a, button, .feature-card, .magnetic');
    hoverables.forEach(el => {
        el.addEventListener('mouseenter', () => follower?.classList.add('cursor-hover'));
        el.addEventListener('mouseleave', () => follower?.classList.remove('cursor-hover'));
    });

    // Typing Animation
    const typingElement = document.querySelector('.typing-text');
    const textToType = "The next-gen AI assistant for developers.";
    let charIndex = 0;

    function typeEffect() {
        if (charIndex < textToType.length) {
            typingElement.textContent += textToType.charAt(charIndex);
            charIndex++;
            setTimeout(typeEffect, 50 + Math.random() * 50);
        }
    }

    // Intersection Observer for Reveal & Stats
    const observerOptions = { threshold: 0.1, rootMargin: '0px 0px -50px 0px' };
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
                
                // If it's the typing text
                if (entry.target.classList.contains('typing-text')) {
                    typeEffect();
                }

                // If it's a stat number
                if (entry.target.classList.contains('stat-item')) {
                    const numElement = entry.target.querySelector('.stat-number');
                    const target = parseFloat(numElement.getAttribute('data-target'));
                    animateCount(numElement, target);
                }

                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    document.querySelectorAll('.reveal, .stat-item').forEach(el => observer.observe(el));

    // Stats Counter Animation
    function animateCount(el, target) {
        let current = 0;
        const duration = 2000;
        const stepTime = 20;
        const increment = target / (duration / stepTime);
        
        const timer = setInterval(() => {
            current += increment;
            if (current >= target) {
                el.textContent = target % 1 === 0 ? target : target.toFixed(1);
                clearInterval(timer);
            } else {
                el.textContent = target % 1 === 0 ? Math.floor(current) : current.toFixed(1);
            }
        }, stepTime);
    }

    // Interactive Console
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-command');
    const consoleOutput = document.getElementById('console-output');

    const handleCommand = () => {
        const text = userInput.value.trim();
        if (!text) return;

        // User Line
        const userLine = document.createElement('div');
        userLine.className = 'line';
        userLine.innerHTML = `<span class="prompt">></span> ${text}`;
        consoleOutput.appendChild(userLine);
        userInput.value = '';

        // Response with fake "processing" state
        setTimeout(() => {
            const respLine = document.createElement('div');
            respLine.className = 'line response';
            
            if (text.toLowerCase().includes('help')) {
                respLine.innerText = "Volt: I can analyze your code, optimize components, and check for security flaws. Try asking 'analyze my project'.";
            } else if (text.toLowerCase().includes('analyze')) {
                respLine.innerText = "Volt: Scan complete. Found 4 potential memory leaks in your useEffect hooks.";
            } else {
                respLine.innerText = "Volt: Command processed. Integrating findings into your local workspace...";
            }
            
            consoleOutput.appendChild(respLine);
            consoleOutput.scrollTop = consoleOutput.scrollHeight;
        }, 800);
    };

    if (sendBtn && userInput) {
        sendBtn.addEventListener('click', handleCommand);
        userInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleCommand();
        });
    }

    // Modal Logic
    const featureCards = document.querySelectorAll('.feature-card');
    const modal = document.getElementById('project-modal');
    const modalBody = document.getElementById('modal-body');
    const closeModal = document.querySelector('.close-modal');

    const capabilityData = {
        "Workspace Awareness": {
            desc: "Full context indexing across all files.",
            tech: ["Vector Embeddings", "LSP"]
        },
        "Real-time Refactoring": {
            desc: "On-the-fly suggestions as you type.",
            tech: ["AST Parsing", "Heuristics"]
        },
        "Security Auditing": {
            desc: "Background scanning for vulnerabilities.",
            tech: ["SAST", "Secret Scanning"]
        }
    };

    featureCards.forEach(card => {
        card.addEventListener('click', () => {
            const title = card.querySelector('h3').innerText;
            const data = capabilityData[title];
            if (!data) return;

            modalBody.innerHTML = `<h2>${title}</h2><p>${data.desc}</p>`;
            modal.style.display = 'block';
            document.body.style.overflow = 'hidden';
        });
    });

    if (closeModal) {
        closeModal.addEventListener('click', () => {
            modal.style.display = 'none';
            document.body.style.overflow = 'auto';
        });
    }
});
