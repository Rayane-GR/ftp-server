/*
 * AppJet Share - Windows desktop client
 * -------------------------------------
 * A native Win32 GUI application (no runtime dependencies) that uploads a file
 * to the global AppJet Share server over HTTPS and returns a public share link.
 *
 * Build (cross-compiled from Linux):
 *   x86_64-w64-mingw32-gcc -O2 -municode -mwindows \
 *     -o AppJetShare.exe AppJetShare.c \
 *     -lwininet -lcomdlg32 -lshell32 -lole32 -luuid -luser32 -lgdi32
 */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <wininet.h>
#include <commdlg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* Compile-time default; can be overridden by the first command line argument. */
#ifndef APPJET_DEFAULT_SERVER
#define APPJET_DEFAULT_SERVER L"https://spqkqbkiyp.dev.onappjet.com"
#endif

#define AGENT          L"AppJetShare-Windows/1.0"
#define BOUNDARY       "----AppJetShareBoundary7MA4YWxkTrZu0gW"

#define ID_BTN_PICK    1001
#define ID_BTN_UPLOAD  1002
#define ID_BTN_COPY    1003
#define ID_BTN_SITE    1004
#define ID_EDIT_LINK   1005
#define ID_STATIC_INFO 1006
#define ID_STATIC_HOST 1007

static wchar_t g_server[512] = APPJET_DEFAULT_SERVER;
static wchar_t g_file[MAX_PATH] = L"";
static wchar_t g_link[2048] = L"";
static HWND g_hwnd;

static void set_info(const wchar_t *text)
{
    SetDlgItemTextW(g_hwnd, ID_STATIC_INFO, text);
    UpdateWindow(g_hwnd);
}

static void set_link(const wchar_t *text)
{
    SetDlgItemTextW(g_hwnd, ID_EDIT_LINK, text);
    wcsncpy(g_link, text, 2047);
    g_link[2047] = 0;
}

/* ------------------------------- HTTP ---------------------------------- */

struct buffer {
    unsigned char *data;
    size_t len;
};

static void buf_free(struct buffer *b)
{
    if (b->data) {
        free(b->data);
    }
    b->data = NULL;
    b->len = 0;
}

static int buf_append(struct buffer *b, const void *src, size_t n)
{
    unsigned char *p = (unsigned char *)realloc(b->data, b->len + n);
    if (!p) {
        return 0;
    }
    memcpy(p + b->len, src, n);
    b->data = p;
    b->len += n;
    return 1;
}

static int buf_append_str(struct buffer *b, const char *s)
{
    return buf_append(b, s, strlen(s));
}

/* Split "https://host/path" into host + path. */
static int split_url(const wchar_t *url, wchar_t *host, size_t hostLen, wchar_t *path, size_t pathLen)
{
    const wchar_t *p = wcsstr(url, L"://");
    if (!p) {
        return 0;
    }
    p += 3;
    const wchar_t *slash = wcschr(p, L'/');
    size_t hostChars = slash ? (size_t)(slash - p) : wcslen(p);
    if (hostChars == 0 || hostChars >= hostLen) {
        return 0;
    }
    wcsncpy(host, p, hostChars);
    host[hostChars] = 0;
    if (slash) {
        wcsncpy(path, slash, pathLen - 1);
        path[pathLen - 1] = 0;
    } else {
        wcsncpy(path, L"/", pathLen - 1);
        path[pathLen - 1] = 0;
    }
    return 1;
}

/* Extract a string value from a flat JSON object (enough for our API). */
static int json_string(const char *json, const char *key, wchar_t *out, size_t outLen)
{
    char pattern[128];
    _snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
    const char *p = strstr(json, pattern);
    if (!p) {
        return 0;
    }
    p += strlen(pattern);
    char raw[2048];
    size_t n = 0;
    while (*p && *p != '"' && n < sizeof(raw) - 1) {
        if (*p == '\\' && p[1] == '/') {
            raw[n++] = '/';
            p += 2;
            continue;
        }
        if (*p == '\\' && p[1] == '"') {
            raw[n++] = '"';
            p += 2;
            continue;
        }
        raw[n++] = *p++;
    }
    raw[n] = 0;
    if (n == 0) {
        return 0;
    }
    int w = MultiByteToWideChar(CP_UTF8, 0, raw, (int)n, out, (int)outLen - 1);
    if (w <= 0) {
        return 0;
    }
    out[w] = 0;
    return 1;
}

/*
 * Upload g_file to the server. Returns 1 on success.
 * On success the public share link is produced.
 */
static int upload_file(wchar_t *shareLink, size_t shareLinkLen, wchar_t *errMsg, size_t errMsgLen)
{
    errMsg[0] = 0;
    shareLink[0] = 0;

    /* read the file */
    HANDLE hFile = CreateFileW(g_file, GENERIC_READ, FILE_SHARE_READ, NULL,
                               OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        wcsncpy(errMsg, L"تعذر فتح الملف المحدد.", errMsgLen - 1);
        return 0;
    }
    LARGE_INTEGER size;
    if (!GetFileSizeEx(hFile, &size) || size.QuadPart > (LONGLONG)1024 * 1024 * 1024) {
        CloseHandle(hFile);
        wcsncpy(errMsg, L"حجم الملف غير مدعوم (الحد الأعلى 1 غيغابايت في التطبيق).", errMsgLen - 1);
        return 0;
    }
    DWORD fileLen = (DWORD)size.QuadPart;
    unsigned char *fileData = (unsigned char *)malloc(fileLen ? fileLen : 1);
    DWORD readTotal = 0;
    if (!fileData || !ReadFile(hFile, fileData, fileLen, &readTotal, NULL) || readTotal != fileLen) {
        if (fileData) free(fileData);
        CloseHandle(hFile);
        wcsncpy(errMsg, L"تعذر قراءة محتوى الملف.", errMsgLen - 1);
        return 0;
    }
    CloseHandle(hFile);

    /* file name (last path component) */
    const wchar_t *baseName = g_file;
    for (const wchar_t *c = g_file; *c; ++c) {
        if (*c == L'\\' || *c == L'/') {
            baseName = c + 1;
        }
    }
    char nameUtf8[520] = {0};
    WideCharToMultiByte(CP_UTF8, 0, baseName, -1, nameUtf8, sizeof(nameUtf8) - 1, NULL, NULL);

    /* build multipart body */
    struct buffer body = {0};
    char head[1024];
    _snprintf(head, sizeof(head),
              "--%s\r\n"
              "Content-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
              "Content-Type: application/octet-stream\r\n\r\n",
              BOUNDARY, nameUtf8);
    buf_append_str(&body, head);
    buf_append(&body, fileData, fileLen);
    free(fileData);
    char tail[128];
    _snprintf(tail, sizeof(tail), "\r\n--%s--\r\n", BOUNDARY);
    buf_append_str(&body, tail);

    wchar_t host[256];
    wchar_t basePath[512];
    if (!split_url(g_server, host, 256, basePath, 512)) {
        buf_free(&body);
        wcsncpy(errMsg, L"عنوان الخادم غير صالح.", errMsgLen - 1);
        return 0;
    }
    wchar_t path[600];
    _snwprintf(path, 600, L"%s/api/upload", basePath);
    path[599] = 0;

    int ok = 0;
    HINTERNET hNet = InternetOpenW(AGENT, INTERNET_OPEN_TYPE_PRECONFIG, NULL, NULL, 0);
    if (!hNet) {
        buf_free(&body);
        wcsncpy(errMsg, L"تعذر تهيئة اتصال الإنترنت.", errMsgLen - 1);
        return 0;
    }
    HINTERNET hConn = InternetConnectW(hNet, host, INTERNET_DEFAULT_HTTPS_PORT, NULL, NULL,
                                       INTERNET_SERVICE_HTTP, 0, 0);
    if (hConn) {
        DWORD flags = INTERNET_FLAG_SECURE | INTERNET_FLAG_NO_CACHE_WRITE |
                      INTERNET_FLAG_RELOAD | INTERNET_FLAG_KEEP_CONNECTION;
        HINTERNET hReq = HttpOpenRequestW(hConn, L"POST", path, NULL, NULL, NULL, flags, 0);
        if (hReq) {
            wchar_t headers[512];
            wcsncpy(headers, L"Content-Type: multipart/form-data; boundary=", 511);
            wcscat(headers, L"" BOUNDARY);
            wcscat(headers, L"\r\nAccept: application/json\r\n");
            BOOL sent = HttpSendRequestW(hReq, headers, (DWORD)-1L,
                                         body.len ? body.data : (LPVOID)"", (DWORD)body.len);
            if (sent) {
                struct buffer resp = {0};
                char chunk[4096];
                DWORD got = 0;
                while (InternetReadFile(hReq, chunk, sizeof(chunk), &got) && got > 0) {
                    buf_append(&resp, chunk, got);
                }
                if (resp.len) {
                    buf_append(&resp, "", 1);
                    if (json_string((const char *)resp.data, "shareUrl", shareLink, shareLinkLen)) {
                        ok = 1;
                    } else if (json_string((const char *)resp.data, "error", errMsg, errMsgLen)) {
                        /* server-provided Arabic error text */
                    } else {
                        wcsncpy(errMsg, L"استجابة غير متوقعة من الخادم.", errMsgLen - 1);
                    }
                }
                buf_free(&resp);
            } else {
                _snwprintf(errMsg, errMsgLen - 1,
                           L"فشل الاتصال بالخادم (رمز %lu).", GetLastError());
                errMsg[errMsgLen - 1] = 0;
            }
            InternetCloseHandle(hReq);
        } else {
            wcsncpy(errMsg, L"تعذر إنشاء طلب الرفع.", errMsgLen - 1);
        }
        InternetCloseHandle(hConn);
    } else {
        _snwprintf(errMsg, errMsgLen - 1, L"تعذر الوصول إلى الخادم (رمز %lu).", GetLastError());
        errMsg[errMsgLen - 1] = 0;
    }
    InternetCloseHandle(hNet);
    buf_free(&body);
    return ok;
}

/* ------------------------------ actions -------------------------------- */

static void on_pick(void)
{
    wchar_t file[MAX_PATH] = L"";
    OPENFILENAMEW ofn;
    ZeroMemory(&ofn, sizeof(ofn));
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = g_hwnd;
    ofn.lpstrFilter = L"كل الملفات\0*.*\0";
    ofn.lpstrFile = file;
    ofn.nMaxFile = MAX_PATH;
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_EXPLORER;
    if (GetOpenFileNameW(&ofn)) {
        wcsncpy(g_file, file, MAX_PATH - 1);
        g_file[MAX_PATH - 1] = 0;
        wchar_t info[MAX_PATH + 64];
        _snwprintf(info, MAX_PATH + 63, L"الملف المحدد: %s", g_file);
        info[MAX_PATH + 63] = 0;
        set_info(info);
        set_link(L"");
    }
}

static DWORD WINAPI upload_thread(LPVOID param)
{
    (void)param;
    wchar_t link[2048];
    wchar_t err[512];
    set_info(L"جارٍ الرفع إلى الخادم العالمي عبر HTTPS…");
    EnableWindow(GetDlgItem(g_hwnd, ID_BTN_UPLOAD), FALSE);
    EnableWindow(GetDlgItem(g_hwnd, ID_BTN_PICK), FALSE);

    if (upload_file(link, 2048, err, 512)) {
        set_link(link);
        set_info(L"تم الرفع بنجاح. الرابط جاهز للمشاركة عالميًا.");
    } else {
        set_link(L"");
        set_info(err[0] ? err : L"فشل الرفع.");
    }

    EnableWindow(GetDlgItem(g_hwnd, ID_BTN_UPLOAD), TRUE);
    EnableWindow(GetDlgItem(g_hwnd, ID_BTN_PICK), TRUE);
    return 0;
}

static void on_upload(void)
{
    if (!g_file[0]) {
        set_info(L"اختر ملفًا أولًا.");
        return;
    }
    HANDLE t = CreateThread(NULL, 0, upload_thread, NULL, 0, NULL);
    if (t) {
        CloseHandle(t);
    }
}

static void on_copy(void)
{
    if (!g_link[0]) {
        set_info(L"لا يوجد رابط لنسخه بعد.");
        return;
    }
    if (OpenClipboard(g_hwnd)) {
        EmptyClipboard();
        size_t bytes = (wcslen(g_link) + 1) * sizeof(wchar_t);
        HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if (mem) {
            void *dst = GlobalLock(mem);
            if (dst) {
                memcpy(dst, g_link, bytes);
                GlobalUnlock(mem);
                if (SetClipboardData(CF_UNICODETEXT, mem)) {
                    set_info(L"تم نسخ الرابط إلى الحافظة.");
                }
            }
        }
        CloseClipboard();
    }
}

static void on_open_site(void)
{
    ShellExecuteW(g_hwnd, L"open", g_server, NULL, NULL, SW_SHOWNORMAL);
}

/* ------------------------------- window -------------------------------- */

static LRESULT CALLBACK wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    switch (msg) {
    case WM_CREATE: {
        g_hwnd = hwnd;
        NONCLIENTMETRICSW ncm;
        ZeroMemory(&ncm, sizeof(ncm));
        ncm.cbSize = sizeof(ncm);
        HFONT font = (HFONT)GetStockObject(DEFAULT_GUI_FONT);
        if (SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(ncm), &ncm, 0)) {
            font = CreateFontIndirectW(&ncm.lfMessageFont);
        }

        CreateWindowExW(0, L"STATIC", L"خادم المشاركة العالمي:",
                        WS_CHILD | WS_VISIBLE, 20, 16, 420, 20, hwnd, NULL, NULL, NULL);
        HWND host = CreateWindowExW(0, L"STATIC", g_server,
                        WS_CHILD | WS_VISIBLE, 20, 38, 420, 20, hwnd, (HMENU)ID_STATIC_HOST, NULL, NULL);

        CreateWindowExW(0, L"BUTTON", L"اختيار ملف…", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                        20, 72, 140, 32, hwnd, (HMENU)ID_BTN_PICK, NULL, NULL);
        CreateWindowExW(0, L"BUTTON", L"رفع ومشاركة", WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON,
                        170, 72, 140, 32, hwnd, (HMENU)ID_BTN_UPLOAD, NULL, NULL);
        CreateWindowExW(0, L"BUTTON", L"فتح الموقع", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                        320, 72, 120, 32, hwnd, (HMENU)ID_BTN_SITE, NULL, NULL);

        CreateWindowExW(0, L"STATIC", L"اختر ملفًا للبدء.", WS_CHILD | WS_VISIBLE,
                        20, 118, 420, 40, hwnd, (HMENU)ID_STATIC_INFO, NULL, NULL);

        HWND edit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"",
                        WS_CHILD | WS_VISIBLE | ES_READONLY | ES_AUTOHSCROLL,
                        20, 166, 340, 26, hwnd, (HMENU)ID_EDIT_LINK, NULL, NULL);
        CreateWindowExW(0, L"BUTTON", L"نسخ الرابط", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                        368, 166, 72, 26, hwnd, (HMENU)ID_BTN_COPY, NULL, NULL);

        HWND kids[] = {host, edit,
                       GetDlgItem(hwnd, ID_STATIC_INFO), GetDlgItem(hwnd, ID_STATIC_HOST),
                       GetDlgItem(hwnd, ID_BTN_PICK), GetDlgItem(hwnd, ID_BTN_UPLOAD),
                       GetDlgItem(hwnd, ID_BTN_SITE), GetDlgItem(hwnd, ID_BTN_COPY)};
        for (int i = 0; i < (int)(sizeof(kids) / sizeof(kids[0])); ++i) {
            if (kids[i] && font) {
                SendMessageW(kids[i], WM_SETFONT, (WPARAM)font, TRUE);
            }
        }
        return 0;
    }
    case WM_COMMAND:
        switch (LOWORD(wp)) {
        case ID_BTN_PICK:   on_pick();      return 0;
        case ID_BTN_UPLOAD: on_upload();    return 0;
        case ID_BTN_COPY:   on_copy();      return 0;
        case ID_BTN_SITE:   on_open_site(); return 0;
        }
        return 0;
    case WM_CLOSE:
        DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, LPWSTR cmdline, int show)
{
    (void)prev;
    (void)cmdline;

    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (argv) {
        if (argc > 1 && wcslen(argv[1]) < 500) {
            wcsncpy(g_server, argv[1], 511);
            g_server[511] = 0;
            size_t n = wcslen(g_server);
            while (n > 0 && g_server[n - 1] == L'/') {
                g_server[--n] = 0;
            }
        }
        LocalFree(argv);
    }

    WNDCLASSEXW wc;
    ZeroMemory(&wc, sizeof(wc));
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = wnd_proc;
    wc.hInstance = inst;
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    wc.lpszClassName = L"AppJetShareWindow";
    wc.hIcon = LoadIcon(NULL, IDI_APPLICATION);
    if (!RegisterClassExW(&wc)) {
        return 1;
    }

    HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"AppJet Share — مشاركة الملفات عالميًا",
                                WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                                CW_USEDEFAULT, CW_USEDEFAULT, 480, 260,
                                NULL, NULL, inst, NULL);
    if (!hwnd) {
        return 1;
    }
    ShowWindow(hwnd, show);
    UpdateWindow(hwnd);

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return 0;
}
