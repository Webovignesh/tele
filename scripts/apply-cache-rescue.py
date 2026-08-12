from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    src = p.read_text()
    if old not in src:
        raise SystemExit(f"{label}: anchor not found")
    p.write_text(src.replace(old, new, 1))


replace_once(
    "server.js",
    "    lastMessage: chat.last_message ? chat.last_message.content : null,\n    username: null\n  }",
    "    lastMessage: chat.last_message ? chat.last_message.content : null,\n    username: null,\n    photoFileId: chat.photo && chat.photo.small ? chat.photo.small.id : null\n  }",
    "chat photo metadata",
)

replace_once(
    "public/index.html",
    '<link rel="stylesheet" href="style.css?v=41">',
    '<link rel="stylesheet" href="style.css?v=41"><link rel="stylesheet" href="rescue-runtime.css?v=1">',
    "runtime css include",
)

replace_once(
    "public/index.html",
    '<button id="tab-files" class="tab active">Files</button>          <button id="tab-messages" class="tab">Messages</button>',
    '<button id="tab-messages" class="tab active">Messages</button>          <button id="tab-files" class="tab">Files</button>',
    "message tab first",
)

replace_once(
    "public/index.html",
    '<div id="messages" class="messages hidden"></div>        <div id="media-grid" class="media-grid"></div>',
    '<div id="messages" class="messages"></div>        <div id="media-grid" class="media-grid hidden"></div>',
    "message pane first",
)

replace_once(
    "public/index.html",
    '<script src="app.js?v=41"></script></body></html>',
    '<script src="app.js?v=41"></script><script src="rescue-runtime.js?v=1"></script></body></html>',
    "runtime js include",
)

print("cache rescue patch applied")
