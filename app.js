// ==========================================
// 1. إدارة الملفات (IndexedDB)
// ==========================================
const DB_NAME = 'ASTAF_V4';
const STORE_NAME = 'files';
let db, currentFileName = 'main.py', editor, pyWorker, isWorkerReady = false, wakeLock = null;
const terminal = document.getElementById('terminal');

function toggleFiles() {
    document.getElementById('files-panel').classList.toggle('translate-x-full');
    document.getElementById('overlay').classList.toggle('hidden');
}

function initDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = e => { if (!e.target.result.objectStoreNames.contains(STORE_NAME)) e.target.result.createObjectStore(STORE_NAME, { keyPath: 'name' }); };
        req.onsuccess = e => { db = e.target.result; resolve(); };
        req.onerror = e => reject(e);
    });
}

function saveFileToDB(name, content) {
    return new Promise(resolve => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ name, content });
        tx.oncomplete = () => resolve();
    });
}

function getFileFromDB(name) {
    return new Promise(resolve => {
        const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(name);
        req.onsuccess = () => resolve(req.result ? req.result.content : null);
    });
}

function getAllFilesFromDB() {
    return new Promise(resolve => {
        const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result);
    });
}

function deleteFileFromDB(name) {
    return new Promise(resolve => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(name);
        tx.oncomplete = () => resolve();
    });
}

// ==========================================
// 2. Wake Lock (منع النوم)
// ==========================================
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            logToTerminal('> Screen Wake Lock Active. Bot will stay alive.', '#38bdf8');
        }
    } catch (e) { logToTerminal('> Wake Lock Failed: ' + e.message, '#ef4444'); }
}

function releaseWakeLock() { if (wakeLock) { wakeLock.release(); wakeLock = null; } }

// ==========================================
// 3. Monaco Editor
// ==========================================
require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' }});
require(['vs/editor/editor.main'], function() {
    editor = monaco.editor.create(document.getElementById('editor-container'), {
        value: `import telebot\nimport time\n\n# ضع التوكن هنا\nbot = telebot.TeleBot("YOUR_TOKEN_HERE")\n\n@bot.message_handler(commands=['start'])\ndef send_welcome(message):\n    bot.reply_to(message, "أهلاً بك يا هلا محمد! البوت يعمل.")\n\nprint("البوت بدأ العمل...")\nwhile True:\n    try:\n        bot.polling(none_stop=True, timeout=10)\n    except Exception as e:\n        print("Error:", e)\n        time.sleep(3)\n`,
        language: 'python',
        theme: 'vs-dark',
        automaticLayout: true,
        fontSize: 13,
        minimap: { enabled: false },
        lineNumbersMinChars: 2
    });
});

// ==========================================
// 4. Pyodide Web Worker
// ==========================================
function logToTerminal(msg, color = '#4ade80') {
    const line = document.createElement('div');
    line.style.color = color;
    line.textContent = msg;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
}

function initPyodideWorker() {
    const workerCode = `
        importScripts("https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js");
        let pyodide; let isRunning = false;
        
        async function init() {
            try {
                pyodide = await loadPyodide({
                    stdout: (text) => postMessage({ type: 'stdout', data: text }),
                    stderr: (text) => postMessage({ type: 'stderr', data: text })
                });
                
                // 1. تحميل micropip
                await pyodide.loadPackage("micropip");
                
                // 2. تحميل وحدة ssl (مهمة جداً لمكتبة تيليجرام)
                await pyodide.loadPackage("ssl");
                
                // 3. تحميل pyodide-http عشان requests يشتغل
                const micropip = pyodide.pyimport("micropip");
                await micropip.install("pyodide-http");
                
                // 4. تفعيل الـ patch للـ requests
                pyodide.runPython(\`
import pyodide_http
pyodide_http.patch_all()
                \`);
                
                postMessage({ type: 'ready' });
            } catch (e) { 
                postMessage({ type: 'error', data: e.message }); 
            }
        }
        
        self.onmessage = async (e) => {
            const { action, code, pkg } = e.data;
            if (action === 'run') {
                if (isRunning) return;
                isRunning = true;
                try { 
                    await pyodide.runPythonAsync(code); 
                } catch (err) { 
                    postMessage({ type: 'stderr', data: err.message }); 
                } finally { 
                    isRunning = false; 
                    postMessage({ type: 'done' }); 
                }
            } else if (action === 'stop') { 
                isRunning = false; 
                self.close(); 
            } else if (action === 'install') {
                try {
                    const micropip = pyodide.pyimport("micropip");
                    await micropip.install(pkg);
                    postMessage({ type: 'stdout', data: "Successfully installed " + pkg });
                } catch (err) { 
                    postMessage({ type: 'stderr', data: "Failed: " + err.message }); 
                }
                postMessage({ type: 'done' });
            }
        };
        init();
    `;
    
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    pyWorker = new Worker(URL.createObjectURL(blob));

    pyWorker.onmessage = (e) => {
        const { type, data } = e.data;
        if (type === 'ready') {
            isWorkerReady = true;
            document.getElementById('loader').style.display = 'none';
            document.getElementById('py-status').className = 'flex items-center gap-1 text-[10px] text-green-400 bg-slate-800 px-2 py-1 rounded';
            document.getElementById('py-status').innerHTML = '<i class="fa-solid fa-circle text-[6px]"></i> جاهز';
            logToTerminal('> Python Ready + SSL. Terminal active.', '#38bdf8');
        } else if (type === 'stdout' || type === 'stderr') {
            logToTerminal(data, type === 'stderr' ? '#ef4444' : '#4ade80');
        } else if (type === 'error') {
            document.getElementById('loader').innerHTML = '<p class="text-red-500 text-xs">Error: ' + data + '</p>';
        } else if (type === 'done') {
            document.getElementById('btn-run').classList.remove('hidden');
            document.getElementById('btn-stop').classList.add('hidden');
        }
    };
}

// ==========================================
// 5. الوظائف (ملفات، تشغيل، تثبيت)
// ==========================================
async function loadFilesList() {
    const files = await getAllFilesFromDB();
    const list = document.getElementById('file-list');
    list.innerHTML = '';
    if (files.length === 0) { 
        await saveFileToDB('main.py', editor ? editor.getValue() : ''); 
        files.push({ name: 'main.py' }); 
    }
    files.forEach(f => {
        const li = document.createElement('li');
        const isActive = f.name === currentFileName;
        li.className = `p-2 rounded flex justify-between items-center cursor-pointer ${isActive ? 'bg-blue-900/50 text-blue-200 border border-blue-700' : 'hover:bg-slate-700'}`;
        li.innerHTML = `<span onclick="openFile('${f.name}')" class="flex-1 truncate"><i class="fa-brands fa-python text-yellow-500 ml-1"></i> ${f.name}</span><button onclick="deleteFile('${f.name}')" class="text-red-400 px-1"><i class="fa-solid fa-trash text-[10px]"></i></button>`;
        list.appendChild(li);
    });
}

async function openFile(name) {
    if (currentFileName && editor) await saveFileToDB(currentFileName, editor.getValue());
    const content = await getFileFromDB(name);
    if (content !== null) {
        currentFileName = name;
        document.getElementById('current-file-name').innerText = name;
        editor.setValue(content);
        loadFilesList();
        if (window.innerWidth < 768) toggleFiles();
    }
}

async function saveCurrentFile() {
    await saveFileToDB(currentFileName, editor.getValue());
    logToTerminal(`> Saved ${currentFileName}`, '#38bdf8');
}

async function createNewFile() {
    const name = prompt('اسم الملف:');
    if (!name) return;
    let fileName = name.endsWith('.py') ? name : name + '.py';
    await saveFileToDB(fileName, '');
    openFile(fileName);
}

async function deleteFile(name) {
    if (!confirm('حذف؟')) return;
    await deleteFileFromDB(name);
    if (name === currentFileName) { 
        currentFileName = 'main.py'; 
        const def = await getFileFromDB('main.py');
        editor.setValue(def || ''); 
    }
    loadFilesList();
}

async function uploadFile(input) {
    const file = input.files[0];
    if (!file) return;
    await saveFileToDB(file.name, await file.text());
    openFile(file.name);
    input.value = '';
}

function runCode() {
    if (!isWorkerReady) return alert('Python غير جاهز!');
    logToTerminal('\n--- RUNNING ---', '#38bdf8');
    document.getElementById('btn-run').classList.add('hidden');
    document.getElementById('btn-stop').classList.remove('hidden');
    requestWakeLock();
    pyWorker.postMessage({ action: 'run', code: editor.getValue() });
}

function stopCode() {
    releaseWakeLock();
    pyWorker.terminate();
    document.getElementById('btn-run').classList.remove('hidden');
    document.getElementById('btn-stop').classList.add('hidden');
    isWorkerReady = false;
    logToTerminal('\n--- STOPPED ---', '#ef4444');
    initPyodideWorker();
}

async function installPackage() {
    if (!isWorkerReady) return alert('Python غير جاهز!');
    const input = document.getElementById('pip-input');
    let pkg = input.value.trim();
    if (!pkg) return;
    if (pkg.startsWith('pip install ')) pkg = pkg.replace('pip install ', '').trim();
    logToTerminal(`\n$ pip install ${pkg}`, '#38bdf8');
    input.value = '';
    pyWorker.postMessage({ action: 'install', pkg });
}

function quickInstall(pkg) {
    document.getElementById('pip-input').value = pkg;
    installPackage();
}

function clearTerminal() { terminal.innerHTML = ''; }

// ==========================================
// 6. التشغيل
// ==========================================
async function boot() {
    await initDB();
    initPyodideWorker();
    setInterval(async () => { 
        if (editor && document.getElementById('file-list').innerHTML === '') {
            await loadFilesList(); 
        }
    }, 500);
}
boot();
