// The support gate (Part 1 §1.6.10): a classic script that runs before the bundle and, when the
// browser lacks a feature the editor needs, shows a plain page instead and flags the bundle's
// entry (src/support.ts) to stop. It offers the old auto save as downloads. Plain ES5 with no
// imports: it can't use the bundle, and it must run in browsers the bundle can't. English only
// (the locale files load with the bundle).
;(function (root) {
    'use strict'

    // src/storage.ts's prefix (package.json's name); tests/platform/gate.test.ts checks they agree.
    var PREFIX = 'sonolus-next-sekai-editor.'

    // The features the design needs (§1.6.10); the names are for tests and the console.
    function missingFeatures(win) {
        var missing = []
        var nav = win.navigator || {}
        if (!win.indexedDB) missing.push('indexedDB')
        if (!nav.storage || typeof nav.storage.estimate !== 'function')
            missing.push('navigator.storage.estimate')
        if (!nav.locks) missing.push('navigator.locks')
        if (typeof win.OffscreenCanvas === 'undefined') missing.push('OffscreenCanvas')
        if (typeof win.structuredClone !== 'function') missing.push('structuredClone')
        return missing
    }

    // WebKit for wording (src/platform/detect.ts): every iPhone and iPad browser, and macOS Safari.
    function isWebKit(win) {
        var nav = win.navigator || {}
        var ua = nav.userAgent || ''
        if (/iPhone|iPad|iPod/.test(ua)) return true
        if (ua.indexOf('Macintosh') !== -1 && nav.maxTouchPoints > 1) return true
        return (
            ua.indexOf('Macintosh') !== -1 &&
            ua.indexOf('Safari/') !== -1 &&
            ua.indexOf('Version/') !== -1 &&
            !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua) &&
            'GestureEvent' in win
        )
    }

    function message(win) {
        return isWebKit(win)
            ? 'This editor needs Safari 17 or later.'
            : 'This browser is too old for the editor.'
    }

    function decodeBase64(text) {
        var binary = root.atob(text)
        var bytes = new root.Uint8Array(binary.length)
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        return bytes
    }

    function isGzip(bytes) {
        return bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b
    }

    function safeName(name) {
        return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    }

    function withExtension(name, extension) {
        return name.slice(-extension.length).toLowerCase() === extension ? name : name + extension
    }

    // An old auto save's stored text as a file: the same choices as src/local/startup/legacy.ts's
    // toRecoveryFile. The v1 form's level data is the gzipped `.nsld`; raw level data goes out
    // unchanged as `.json`; anything else as the stored text.
    function toRecoveryFile(text) {
        try {
            var data = JSON.parse(text)
            if (typeof data === 'object' && data !== null) {
                var name =
                    typeof data.filename === 'string' && data.filename ? data.filename : 'Recovery'
                if (typeof data.levelData === 'string') {
                    var bytes = decodeBase64(data.levelData)
                    if (isGzip(bytes))
                        return {
                            name: safeName(withExtension(name, '.nsld')),
                            type: 'application/octet-stream',
                            data: bytes,
                        }
                }
                if ('entities' in data)
                    return {
                        name: safeName(withExtension(name, '.json')),
                        type: 'application/json',
                        data: text,
                    }
            }
        } catch (error) {
            // Damaged; kept as text below.
        }
        return { name: 'Recovery.txt', type: 'text/plain', data: text }
    }

    // Everything stored that the gate offers, in order: the auto save, then an unreadable one set
    // aside. `storage` is localStorage.
    function recoveryFiles(storage) {
        var files = []
        var autoSave = [
            ['autoSave.levelData', 'Download Your Last Auto Save'],
            ['autoSave.unreadable', 'Download Unreadable Auto Save'],
        ]
        for (var i = 0; i < autoSave.length; i++) {
            var text = storage.getItem(PREFIX + autoSave[i][0])
            if (text === null) continue
            var file = toRecoveryFile(text)
            file.label = autoSave[i][1]
            files.push(file)
        }
        return files
    }

    function download(win, file) {
        var doc = win.document
        var url = win.URL.createObjectURL(new win.Blob([file.data], { type: file.type }))
        var link = doc.createElement('a')
        link.href = url
        link.download = file.name
        link.style.display = 'none'
        doc.body.appendChild(link)
        link.click()
        doc.body.removeChild(link)
        win.setTimeout(function () {
            win.URL.revokeObjectURL(url)
        }, 30000)
    }

    function show(win, text, files) {
        var doc = win.document
        var style = doc.documentElement.style
        style.colorScheme = 'light dark'
        var body = doc.body
        // The stylesheet's reset (when it has loaded) leaves buttons bare, and the page can't scroll.
        body.style.touchAction = 'auto'
        body.style.margin = '0'
        body.style.fontFamily = 'system-ui, -apple-system, sans-serif'
        var main = doc.createElement('main')
        main.style.maxWidth = '36rem'
        main.style.margin = '0 auto'
        main.style.padding = '3rem 1rem'
        var paragraph = doc.createElement('p')
        paragraph.style.fontSize = '1.25rem'
        paragraph.textContent = text
        main.appendChild(paragraph)
        files.forEach(function (file) {
            var button = doc.createElement('button')
            button.type = 'button'
            button.textContent = file.label
            button.style.display = 'block'
            button.style.margin = '0.75rem 0'
            button.style.padding = '0.625rem 1rem'
            button.style.font = 'inherit'
            button.style.color = 'inherit'
            button.style.background = 'transparent'
            button.style.border = '1px solid currentColor'
            button.style.borderRadius = '0.5rem'
            button.style.cursor = 'pointer'
            button.addEventListener('click', function () {
                download(win, file)
            })
            main.appendChild(button)
        })
        body.appendChild(main)
    }

    // Returns true when the browser is unsupported. An insecure context skips the check: storage
    // is unavailable there anyway (§1.6.5).
    function run(win) {
        if (win.isSecureContext === false) return false
        var missing = missingFeatures(win)
        if (!missing.length) return false
        var files = []
        try {
            files = recoveryFiles(win.localStorage)
        } catch (error) {
            // Storage can be unavailable or damaged; the message still shows.
        }
        // The bundle's entry is the next script and throws at once on this flag (src/support.ts).
        win.nseUnsupported = true
        var doc = win.document
        doc.documentElement.setAttribute('data-gate', 'unsupported')
        // The body isn't parsed yet: the page goes in once it is.
        if (doc.readyState === 'loading')
            doc.addEventListener('DOMContentLoaded', function () {
                show(win, message(win), files)
            })
        else show(win, message(win), files)
        return true
    }

    var api = {
        PREFIX: PREFIX,
        missingFeatures: missingFeatures,
        isWebKit: isWebKit,
        message: message,
        toRecoveryFile: toRecoveryFile,
        recoveryFiles: recoveryFiles,
        run: run,
    }
    if (typeof module === 'object' && module.exports) module.exports = api
    else run(root)
})(this)
