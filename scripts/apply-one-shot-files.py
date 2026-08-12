from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    src = p.read_text()
    if old not in src:
        raise SystemExit(f"{label}: anchor not found")
    p.write_text(src.replace(old, new, 1))


# Speed up initial chat-list hydration by resolving chat metadata concurrently.
replace_once(
    "server.js",
    """  const out = []\n  for (const id of ids) {\n    try {\n      const chat = await client.invoke({ _: 'getChat', chat_id: id })\n      const t = chat.type\n      if (t && t._ === 'chatTypeSecret') continue\n      out.push(await serializeChatDetailed(chat))\n    } catch (e) {}\n  }""",
    """  const out = (await Promise.all(ids.map(async (id) => {\n    try {\n      const chat = await client.invoke({ _: 'getChat', chat_id: id })\n      const t = chat.type\n      if (t && t._ === 'chatTypeSecret') return null\n      return await serializeChatDetailed(chat)\n    } catch (e) {\n      return null\n    }\n  }))).filter(Boolean)""",
    "parallel chat hydration",
)

# Runtime: remember the chosen tab, keep complete file snapshots per chat, and only
# reveal Files after a whole-chat scan has finished. This removes the 51 -> 100 ->
# 150 incremental visual churn for media-heavy channels.
p = Path("public/rescue-runtime.js")
s = p.read_text()

s = s.replace(
    "const rescueChatCache = new Map()\nconst rescueInflight = new Map()",
    "const rescueChatCache = new Map()\nconst rescueFileCache = new Map()\nconst rescueFileInflight = new Map()\nconst rescueInflight = new Map()",
    1,
)

s = s.replace(
    "let rescueSyncTimer = null\n\nfunction rescueChatKey",
    """let rescueSyncTimer = null\n\nfunction rescuePreferredView () {\n  try {\n    const saved = localStorage.getItem('tele-active-tab')\n    return saved === 'files' ? 'files' : 'messages'\n  } catch {\n    return 'messages'\n  }\n}\n\nfunction rescueRememberView (view) {\n  try { localStorage.setItem('tele-active-tab', view) } catch {}\n}\n\nfunction rescueChatKey""",
    1,
)

# Do not let background message refreshes progressively repaint the Files tab while
# its complete snapshot is still scanning.
s = s.replace(
    """function rescueRenderCurrent () {\n  if (state.view === 'messages') renderMessagesList()\n  else renderFiles()\n  rescueUpdateMediaLabel()\n}""",
    """function rescueRenderCurrent () {\n  if (state.view === 'messages') {\n    renderMessagesList()\n  } else {\n    const key = state.activeChatId == null ? null : rescueChatKey(state.activeChatId)\n    if (!key || !rescueFileInflight.has(key)) renderFiles()\n  }\n  rescueUpdateMediaLabel()\n}\n\nfunction rescueApplyCompleteFiles (chatId, snapshot) {\n  if (!snapshot || !Array.isArray(snapshot.items)) return\n  const keep = state.messages.filter(m => !m.media)\n  const mediaMessages = snapshot.items.map(it => ({\n    ...it,\n    id: it.messageId,\n    key: `${chatId}:${it.messageId}`,\n    media: it\n  }))\n  state.messages = [...keep, ...mediaMessages].sort((a, b) => {\n    const aa = BigInt(String(a.id || 0))\n    const bb = BigInt(String(b.id || 0))\n    return aa === bb ? 0 : (aa < bb ? 1 : -1)\n  })\n  state.mediaCount = snapshot.found == null ? snapshot.items.length : snapshot.found\n  state.typeCounts = snapshot.typeCounts || null\n  state.hasMore = false\n}\n\nasync function rescueEnsureAllFiles (chatId) {\n  if (chatId == null) return\n  const key = rescueChatKey(chatId)\n  const cached = rescueFileCache.get(key)\n  if (cached) {\n    if (rescueChatKey(state.activeChatId) !== key) return\n    rescueApplyCompleteFiles(chatId, cached)\n    renderFiles()\n    rescueUpdateMediaLabel()\n    setLoadState(`Loaded all ${cached.items.length} files`)\n    return\n  }\n  if (rescueFileInflight.has(key)) return rescueFileInflight.get(key)\n\n  if (rescueChatKey(state.activeChatId) === key) {\n    $('#media-grid').innerHTML = ''\n    setLoadState('Loading all files…')\n  }\n\n  const generation = rescueOpenGeneration\n  const work = (async () => {\n    try {\n      let data = await request('scan-media', { chatId, includeItems: true })\n      while (data && data.busy) {\n        await new Promise(resolve => setTimeout(resolve, 750))\n        if (rescueChatKey(state.activeChatId) !== key || generation !== rescueOpenGeneration) return\n        data = await request('scan-media', { chatId, includeItems: true })\n      }\n      const snapshot = {\n        items: (data && data.items) || [],\n        found: data && data.found,\n        typeCounts: data && data.typeCounts,\n        savedAt: Date.now()\n      }\n      rescueFileCache.set(key, snapshot)\n      if (rescueChatKey(state.activeChatId) !== key || generation !== rescueOpenGeneration || state.view !== 'files') return\n      rescueApplyCompleteFiles(chatId, snapshot)\n      renderFiles()\n      rescueUpdateMediaLabel()\n      setLoadState(`Loaded all ${snapshot.items.length} files`)\n    } catch (e) {\n      if (rescueChatKey(state.activeChatId) === key && state.view === 'files') {\n        setLoadState('Failed to load all files. Try Files again.')\n        toast(String(e && e.message ? e.message : e), 'error')\n      }\n    } finally {\n      rescueFileInflight.delete(key)\n    }\n  })()\n  rescueFileInflight.set(key, work)\n  return work\n}""",
    1,
)

# Persist tab selection and make Files a complete-snapshot view.
s = s.replace(
    """// Replace the old eager whole-history counter. Whole-chat work is now only\n// initiated by explicit user actions (Download all / Search whole chat).\nupdateMediaCountLabel = rescueUpdateMediaLabel""",
    """// Replace the old eager whole-history counter. Whole-chat work is now only\n// initiated by explicit user actions (Download all / Search whole chat).\nupdateMediaCountLabel = rescueUpdateMediaLabel\n\nconst rescueBaseSetView = setView\nsetView = function rescueSetView (view) {\n  rescueRememberView(view)\n  rescueBaseSetView(view)\n  if (view === 'files' && state.activeChatId != null) {\n    rescueEnsureAllFiles(state.activeChatId)\n  }\n}""",
    1,
)

# Opening another chat respects the last selected tab instead of forcing Messages.
s = s.replace(
    """  // Messages are the daily-driver default. Files are derived from the same cache.\n  setView('messages')\n  renderMessagesList()\n  renderFiles()\n  rescueUpdateMediaLabel()\n  setLoadState(cached ? `Cached ${state.messages.length} messages · refreshing…` : 'loading')""",
    """  const preferredView = rescuePreferredView()\n  setView(preferredView)\n  renderMessagesList()\n  if (preferredView === 'files') {\n    const fileSnapshot = rescueFileCache.get(rescueChatKey(chatId))\n    if (fileSnapshot) {\n      rescueApplyCompleteFiles(chatId, fileSnapshot)\n      renderFiles()\n      setLoadState(`Loaded all ${fileSnapshot.items.length} files`)\n    } else {\n      $('#media-grid').innerHTML = ''\n      setLoadState('Loading all files…')\n    }\n  } else {\n    renderFiles()\n    setLoadState(cached ? `Cached ${state.messages.length} messages · refreshing…` : 'loading')\n  }\n  rescueUpdateMediaLabel()""",
    1,
)

# If a chat is removed, clear both caches.
s = s.replace(
    """        rescueChatCache.delete(chatKey)\n        removeChat(chatId)""",
    """        rescueChatCache.delete(chatKey)\n        rescueFileCache.delete(chatKey)\n        removeChat(chatId)""",
    1,
)
s = s.replace(
    """        rescueChatCache.delete(rescueChatKey(chatId))\n        removeChat(chatId)""",
    """        rescueChatCache.delete(rescueChatKey(chatId))\n        rescueFileCache.delete(rescueChatKey(chatId))\n        removeChat(chatId)""",
    1,
)

# Slow down safety reconciliation: update events remain realtime, while this poll is
# only a fallback and should not keep rehydrating a large chat list every 7 seconds.
s = s.replace("  }, 7000)", "  }, 15000)", 1)

# Initial tab follows persistent preference.
s = s.replace(
    """state.view = 'messages'\n$('#tab-messages').classList.add('active')\n$('#tab-files').classList.remove('active')\n$('#messages').classList.remove('hidden')\n$('#media-grid').classList.add('hidden')\n$('#files-toolbar').classList.add('hidden')""",
    """const rescueInitialView = rescuePreferredView()\nstate.view = rescueInitialView\n$('#tab-messages').classList.toggle('active', rescueInitialView === 'messages')\n$('#tab-files').classList.toggle('active', rescueInitialView === 'files')\n$('#messages').classList.toggle('hidden', rescueInitialView !== 'messages')\n$('#media-grid').classList.toggle('hidden', rescueInitialView !== 'files')\n$('#files-toolbar').classList.toggle('hidden', rescueInitialView !== 'files')""",
    1,
)

p.write_text(s)
print("one-shot files and persistent tab patch applied")
