// ==========================================
// 1. إدارة الملفات والتخزين (IndexedDB)
// ==========================================
const DB_NAME = 'ASTAF_DB_V2';
const STORE_NAME = 'files';
let db;

function initDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = e => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'name' });
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
// 2. إعداد Monaco Editor
// ==========================================
let editor;
let currentFileName = 'main.py';

require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' }});
require(['vs/editor/editor.main'], function() {
    editor = monaco.editor.create(document.getElementById('editor-container'), {
        value: "# مرحباً بك في ASTAF V2\n# اكتب كود بايثون هنا، ثم اضغط تشغيل.\n\nprint('Hello, ASTAF!')\n",
        language: 'python',
        theme: 'vs-dark',
        automaticLayout: true,
        fontSize: 14,
        minimap: { enabled: false },
        lineNumbers: 'on'
    });
});

// ==========================================
// 3. إعداد Pyodide Web Worker
// ==========================================
let pyWorker;
const terminal = document.getElementById('terminal');
let isWorkerReady = false;

function logToTerminal(msg, color = '#4ade80') {
    const line = document.createElement('div');
    line.style.color = color;
    line.textContent = msg;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
}

function initPyodideWorker() {
    // كود الـ Worker (يعمل في الخلفية لمنع تجميد الواجهة)
    const workerCode = `
        importScripts("https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js");
        
        let pyodide;
        let isRunning = false;

        async function init() {
            try {
                pyodide = await loadPyodide({
                    stdout: (text) => postMessage({ type: 'stdout', data: text }),
                    stderr: (text) => postMessage({ type: 'stderr', data: text })
                });
                
                // تحميل pyodide-http لكي تعمل طلبات requests و telebot
                await pyodide.loadPackage("micropip");
                const micropip = pyodide.pyimport("micropip");
                await micropip.install("pyodide-http");
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
                self.close(); // إيقاف قسري
            } else if (action === 'install') {
                try {
                    const micropip = pyodide.pyimport("micropip");
                    await micropip.install(pkg);
                    postMessage({ type: 'stdout', data: "Successfully installed " + pkg });
                } catch (err) {
                    postMessage({ type: 'stderr', data: "Failed to install " + pkg + ": " + err.message });
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
            document.getElementById('py-status').className = 'flex items-center gap-2 text-green-400';
            document.getElementById('py-status').innerHTML = '<i class="fa-solid fa-circle text-xs"></i> Python جاهز';
            logToTerminal('Python Ready (WebAssembly)', '#38bdf8');
        } else if (type === 'stdout' || type === 'stderr') {
            logToTerminal(data, type === 'stderr' ? '#ef4444' : '#4ade80');
        } else if (type === 'error') {
            document.getElementById('loader-msg').innerText = 'فشل التحميل: ' + data;
            document.getElementById('loader-msg').style.color = 'red';
        } else if (type === 'done') {
            document.getElementById('btn-run').classList.remove('hidden');
            document.getElementById('btn-stop').classList.add('hidden');
        }
    };
}

// ==========================================
// 4. التحكم بالواجهة (تشغيل، إيقاف، رفع)
// ==========================================
async function loadFilesList() {
    const files = await getAllFilesFromDB();
    const list = document.getElementById('file-list');
    list.innerHTML = '';
    
    if (files.length === 0) {
        await saveFileToDB('main.py', editor ? editor.getValue() : "# مرحباً بك\nprint('Hello')\n");
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
    
    const exists = await getFileFromDB(fileName);
    if (exists !== null) return alert('الملف موجود مسبقاً');
    
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
    pyWorker.postMessage({ action: 'run', code });
}

function stopCode() {
    if (!isWorkerReady) return;
    logToTerminal('\n--- إيقاف قسري للبوت ---', '#ef4444');
    pyWorker.terminate(); 
    document.getElementById('btn-run').classList.remove('hidden');
    document.getElementById('btn-stop').classList.add('hidden');
    isWorkerReady = false;
    initPyodideWorker(); // إعادة تشغيل الخيط
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
// 5. التشغيل الأولي
// ==========================================
async function boot() {
    await initDB();
    initPyodideWorker();
    
    const checkEditor = setInterval(async () => {
        if (editor) {
            clearInterval(checkEditor);
            await loadFilesList();
        }
    }, 100);
}

boot();
