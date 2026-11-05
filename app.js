// ==========================================
// 1. إدارة الملفات (IndexedDB)
// ==========================================
const DB_NAME = 'ASTAF_V3';
const STORE_NAME = 'files';
let db;
let currentFileName = 'main.py';
let editor;
let pyWorker;
let isWorkerReady = false;
const terminal = document.getElementById('terminal');

// إدارة القائمة الجانبية للموبايل
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('overlay');
    sidebar.classList.toggle('-translate-x-full');
    overlay.classList.toggle('hidden');
}

function initDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = e => {
            if (!e.target.result.objectStoreNames.contains(STORE_NAME)) {
                e.target.result.createObjectStore(STORE_NAME, { keyPath: 'name' });
            }
        };
        req.onsuccess = e => { db = e.target.result; resolve(); };
        req.onerror = e => reject(e);
    });
}

function saveFileToDB(name, content) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ name, content });
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e);
    });
}

function getFileFromDB(name) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(name);
        req.onsuccess = () => resolve(req.result ? req.result.content : null);
        req.onerror = e => reject(e);
    });
}

function getAllFilesFromDB() {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = e => reject(e);
    });
}

function deleteFileFromDB(name) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(name);
        tx.oncomplete = () => resolve();
        tx.onerror = e => reject(e);
    });
}

// ==========================================
// 2. Wake Lock API (منع الشاشة من النوم)
// ==========================================
let wakeLock = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            document.getElementById('wake-status').classList.remove('hidden');
            document.getElementById('wake-status').classList.add('flex');
            logToTerminal('تم تفعيل وضع "الشاشة النشطة". البوت لن يتوقف طالما الشاشة مفتوحة.', '#38bdf8');
        }
    } catch (err) {
        logToTerminal('فشل تفعيل Wake Lock: ' + err.message, '#ef4444');
    }
}

function releaseWakeLock() {
    if (wakeLock !== null) {
        wakeLock.release().then(() => {
            wakeLock = null;
            document.getElementById('wake-status').classList.add('hidden');
            document.getElementById('wake-status').classList.remove('flex');
        });
    }
}

// ==========================================
// 3. إعداد Monaco Editor
// ==========================================
require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' }});
require(['vs/editor/editor.main'], function() {
    editor = monaco.editor.create(document.getElementById('editor-container'), {
        value: "# اكتب الكود هنا\nprint('Hello ASTAF')\n",
        language: 'python',
        theme: 'vs-dark',
        automaticLayout: true,
        fontSize: 14,
        minimap: { enabled: false }
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
                await pyodide.loadPackage("micropip");
                const micropip = pyodide.pyimport("micropip");
                await micropip.install("pyodide-http");
                pyodide.runPython(\`import pyodide_http; pyodide_http.patch_all()\`);
                postMessage({ type: 'ready' });
            } catch (e) { postMessage({ type: 'error', data: e.message }); }
        }
        self.onmessage = async (e) => {
            const { action, code, pkg } = e.data;
            if (action === 'run') {
                if (isRunning) return;
                isRunning = true;
                try { await pyodide.runPythonAsync(code); } 
                catch (err) { postMessage({ type: 'stderr', data: err.message }); } 
                finally { isRunning = false; postMessage({ type: 'done' }); }
            } else if (action === 'stop') { isRunning = false; self.close(); } 
            else if (action === 'install') {
                try {
                    const micropip = pyodide.pyimport("micropip");
                    await micropip.install(pkg);
                    postMessage({ type: 'stdout', data: "تم تثبيت " + pkg });
                } catch (err) { postMessage({ type: 'stderr', data: "فشل تثبيت " + pkg + ": " + err.message }); }
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
            document.getElementById('py-status').className = 'flex items-center gap-1 text-green-400 bg-slate-800 px-2 py-1 rounded';
            document.getElementById('py-status').innerHTML = '<i class="fa-solid fa-circle text-[8px]"></i> جاهز';
            logToTerminal('Python Ready!', '#38bdf8');
        } else if (type === 'stdout' || type === 'stderr') {
            logToTerminal(data, type === 'stderr' ? '#ef4444' : '#4ade80');
        } else if (type === 'error') {
            document.getElementById('loader').innerHTML = '<p class="text-red-500">فشل التحميل: ' + data + '</p>';
        } else if (type === 'done') {
            document.getElementById('btn-run').classList.remove('hidden');
            document.getElementById('btn-stop').classList.add('hidden');
        }
    };
}

// ==========================================
// 5. الأزرار والواجهة
// ==========================================
async function loadFilesList() {
    const files = await getAllFilesFromDB();
    const list = document.getElementById('file-list');
    list.innerHTML = '';
    if (files.length === 0) {
        await saveFileToDB('main.py', editor ? editor.getValue() : '');
        files.push({ name: 'main.py' });
    }
    files.sort((a,b) => a.name.localeCompare(b.name));
    files.forEach(f => {
        const li = document.createElement('li');
        const isActive = f.name === currentFileName;
        li.className = `p-2 rounded cursor-pointer flex justify-between items-center ${isActive ? 'bg-blue-900/50 text-blue-200 border border-blue-700' : 'hover:bg-slate-700'}`;
        li.innerHTML = `
            <span onclick="openFile('${f.name}')" class="flex-1 flex items-center gap-2 truncate">
                <i class="fa-brands fa-python text-yellow-500"></i> ${f.name}
            </span>
            <button onclick="deleteFile('${f.name}')" class="text-red-400 hover:text-red-300 px-2"><i class="fa-solid fa-trash text-xs"></i></button>
        `;
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
        if (window.innerWidth < 768) toggleSidebar(); // إغلاق القائمة في الموبايل
    }
}

async function saveCurrentFile() {
    if (!currentFileName) return;
    await saveFileToDB(currentFileName, editor.getValue());
    logToTerminal(`تم حفظ ${currentFileName}`, '#38bdf8');
    loadFilesList();
}

async function createNewFile() {
    const name = prompt('اسم الملف الجديد (مثال: bot.py):');
    if (!name) return;
    let fileName = name.endsWith('.py') ? name : name + '.py';
    if (await getFileFromDB(fileName) !== null) return alert('الملف موجود مسبقاً');
    await saveFileToDB(fileName, '');
    openFile(fileName);
}

async function deleteFile(name) {
    if (!confirm(`حذف الملف ${name}؟`)) return;
    await deleteFileFromDB(name);
    if (name === currentFileName) {
        currentFileName = 'main.py';
        document.getElementById('current-file-name').innerText = 'main.py';
        const def = await getFileFromDB('main.py');
        editor.setValue(def || '');
    }
    loadFilesList();
}

async function uploadFile(input) {
    const file = input.files[0];
    if (!file) return;
    const text = await file.text();
    await saveFileToDB(file.name, text);
    openFile(file.name);
    input.value = '';
}

function runCode() {
    if (!isWorkerReady) return alert('بايثون لم يكتمل تحميله بعد.');
    const code = editor.getValue();
    logToTerminal('\n--- بدء التشغيل ---', '#38bdf8');
    document.getElementById('btn-run').classList.add('hidden');
    document.getElementById('btn-stop').classList.remove('hidden');
    
    // تفعيل منع النوم
    requestWakeLock(); 
    
    pyWorker.postMessage({ action: 'run', code });
}

function stopCode() {
    if (!isWorkerReady) return;
    logToTerminal('\n--- إيقاف قسري ---', '#ef4444');
    
    // إلغاء منع النوم
    releaseWakeLock(); 
    
    pyWorker.terminate(); 
    document.getElementById('btn-run').classList.remove('hidden');
    document.getElementById('btn-stop').classList.add('hidden');
    isWorkerReady = false;
    initPyodideWorker(); 
}

async function installPackage() {
    if (!isWorkerReady) return alert('بايثون لم يكتمل تحميله بعد.');
    const input = document.getElementById('pip-input');
    let pkg = input.value.trim();
    if (!pkg) return;
    if (pkg.startsWith('pip install ')) pkg = pkg.replace('pip install ', '').trim();
    logToTerminal(`\n> pip install ${pkg}`, '#38bdf8');
    input.value = '';
    pyWorker.postMessage({ action: 'install', pkg });
}

function clearTerminal() { terminal.innerHTML = ''; }

// ==========================================
// 6. التشغيل
// ==========================================
async function boot() {
    await initDB();
    initPyodideWorker();
    const checkEditor = setInterval(async () => {
        if (editor) { clearInterval(checkEditor); await loadFilesList(); }
    }, 100);
}
boot();
