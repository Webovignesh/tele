'use strict'

/* Telegram management workspace.
 * Adds channel/group creation plus a permission-aware Chat Info drawer without
 * disturbing the proven downloader, forwarding, message, or file pipelines.
 */

;(function initTelegramManagementWorkspace () {
  const ui = {
    drawerMode: loadPref('tele-right-panel') === 'info' ? 'info' : 'downloads',
    infoGeneration: 0,
    info: null,
    createStep: 1,
    createDraft: defaultCreateDraft(),
    memberLoading: false
  }

  function loadPref (key) {
    try { return localStorage.getItem(key) } catch { return null }
  }

  function savePref (key, value) {
    try { localStorage.setItem(key, value) } catch {}
  }

  function elem (tag, cls, text) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text != null) node.textContent = text
    return node
  }

  function button (text, cls, onClick) {
    const b = elem('button', cls || '', text)
    b.type = 'button'
    if (onClick) b.onclick = onClick
    return b
  }

  function labelled (label, control) {
    const wrap = elem('label', 'mg-field')
    wrap.appendChild(elem('span', 'mg-label', label))
    wrap.appendChild(control)
    return wrap
  }

  function textInput (value, placeholder) {
    const input = elem('input', 'mg-input')
    input.type = 'text'
    input.value = value == null ? '' : String(value)
    input.placeholder = placeholder || ''
    input.autocomplete = 'off'
    return input
  }

  function textarea (value, placeholder) {
    const input = elem('textarea', 'mg-textarea')
    input.value = value == null ? '' : String(value)
    input.placeholder = placeholder || ''
    input.rows = 4
    return input
  }

  function defaultCreateDraft () {
    return {
      type: 'channel',
      title: '',
      description: '',
      visibility: 'private',
      username: '',
      members: '',
      forum: false,
      autoDeleteTime: 0
    }
  }

  function formatKind (kind) {
    return ({ channel: 'Channel', supergroup: 'Group', group: 'Group', private: 'Private chat' })[kind] || 'Chat'
  }

  function formatAutoDelete (seconds) {
    const s = Number(seconds || 0)
    if (!s) return 'Off'
    if (s % 86400 === 0) {
      const days = s / 86400
      if (days === 1) return '1 day'
      if (days === 7) return '1 week'
      if (days === 30) return '1 month'
      if (days === 365) return '1 year'
      return `${days} days`
    }
    return `${s}s`
  }

  function normalizeUsername (value) {
    return String(value || '').trim().replace(/^@/, '')
  }

  function parseMemberUsernames (value) {
    return [...new Set(String(value || '')
      .split(/[\s,;]+/)
      .map(normalizeUsername)
      .filter(Boolean))]
      .slice(0, 20)
  }

  /* ------------------------------ Drawer ------------------------------ */

  function mountDrawer () {
    const drawer = document.querySelector('.downloads')
    if (!drawer || drawer.dataset.managementMounted === '1') return
    drawer.dataset.managementMounted = '1'

    const originalChildren = [...drawer.children]
    const tabs = elem('div', 'mg-drawer-tabs')
    const downloadsTab = button('Downloads', 'mg-drawer-tab', () => showDrawer('downloads'))
    downloadsTab.id = 'mg-tab-downloads'
    const infoTab = button('Chat Info', 'mg-drawer-tab', () => showDrawer('info'))
    infoTab.id = 'mg-tab-info'
    tabs.append(downloadsTab, infoTab)

    const downloadsPane = elem('div', 'mg-drawer-pane')
    downloadsPane.id = 'mg-downloads-pane'
    for (const child of originalChildren) downloadsPane.appendChild(child)

    const infoPane = elem('div', 'mg-drawer-pane mg-info-pane hidden')
    infoPane.id = 'mg-info-pane'
    infoPane.appendChild(emptyInfoState())

    drawer.append(tabs, downloadsPane, infoPane)
    showDrawer(ui.drawerMode, false)
  }

  function emptyInfoState () {
    const box = elem('div', 'mg-empty')
    box.appendChild(elem('div', 'mg-empty-icon', 'ⓘ'))
    box.appendChild(elem('strong', '', 'Select a chat'))
    box.appendChild(elem('span', 'muted', 'Chat settings and management actions will appear here.'))
    return box
  }

  function showDrawer (mode, persist = true) {
    mountDrawer()
    const drawer = document.querySelector('.downloads')
    const downloadsPane = document.querySelector('#mg-downloads-pane')
    const infoPane = document.querySelector('#mg-info-pane')
    if (!drawer || !downloadsPane || !infoPane) return

    ui.drawerMode = mode === 'info' ? 'info' : 'downloads'
    if (persist) savePref('tele-right-panel', ui.drawerMode)
    drawer.style.display = ''
    downloadsPane.classList.toggle('hidden', ui.drawerMode !== 'downloads')
    infoPane.classList.toggle('hidden', ui.drawerMode !== 'info')
    document.querySelector('#mg-tab-downloads')?.classList.toggle('active', ui.drawerMode === 'downloads')
    document.querySelector('#mg-tab-info')?.classList.toggle('active', ui.drawerMode === 'info')
    if (ui.drawerMode === 'info') refreshChatInfo()
  }

  function mountEntryPoints () {
    const sidebarHead = document.querySelector('.sidebar-head')
    if (sidebarHead && !document.querySelector('#mg-create-chat')) {
      const create = button('+ Create', 'ghost small mg-create-chat', openCreateWizard)
      create.id = 'mg-create-chat'
      const user = sidebarHead.querySelector('.user')
      if (user) sidebarHead.insertBefore(create, user)
      else sidebarHead.appendChild(create)
    }

    const chatActions = document.querySelector('.chat-actions')
    if (chatActions && !document.querySelector('#mg-open-info')) {
      const info = button('Chat info', 'ghost', () => showDrawer('info'))
      info.id = 'mg-open-info'
      chatActions.prepend(info)
    }
  }

  /* ------------------------------ Create wizard ------------------------------ */

  function ensureCreateModal () {
    let modal = document.querySelector('#mg-create-modal')
    if (modal) return modal

    modal = elem('div', 'mg-modal hidden')
    modal.id = 'mg-create-modal'
    modal.innerHTML = `
      <div class="mg-dialog mg-create-dialog" role="dialog" aria-modal="true" aria-labelledby="mg-create-title">
        <div class="mg-dialog-head">
          <div>
            <div class="mg-kicker">Telegram management</div>
            <h2 id="mg-create-title">Create</h2>
          </div>
          <button id="mg-create-close" class="ghost small" type="button">✕</button>
        </div>
        <div id="mg-create-progress" class="mg-progress"></div>
        <div id="mg-create-body" class="mg-create-body"></div>
        <div class="mg-dialog-foot">
          <button id="mg-create-back" class="ghost" type="button">Back</button>
          <div class="mg-dialog-foot-spacer"></div>
          <button id="mg-create-next" type="button">Next</button>
        </div>
      </div>`
    document.body.appendChild(modal)
    modal.addEventListener('mousedown', e => { if (e.target === modal) closeCreateWizard() })
    document.querySelector('#mg-create-close').onclick = closeCreateWizard
    document.querySelector('#mg-create-back').onclick = () => {
      captureCreateStep()
      if (ui.createStep > 1) ui.createStep--
      renderCreateWizard()
    }
    document.querySelector('#mg-create-next').onclick = onCreateNext
    return modal
  }

  function openCreateWizard () {
    ensureCreateModal()
    ui.createDraft = defaultCreateDraft()
    ui.createStep = 1
    renderCreateWizard()
    document.querySelector('#mg-create-modal').classList.remove('hidden')
  }

  function closeCreateWizard () {
    document.querySelector('#mg-create-modal')?.classList.add('hidden')
  }

  function captureCreateStep () {
    const draft = ui.createDraft
    if (ui.createStep === 2) {
      const title = document.querySelector('#mg-create-chat-title')
      const description = document.querySelector('#mg-create-description')
      const forum = document.querySelector('#mg-create-forum')
      const autoDelete = document.querySelector('#mg-create-auto-delete')
      if (title) draft.title = title.value.trim()
      if (description) draft.description = description.value.trim()
      if (forum) draft.forum = !!forum.checked
      if (autoDelete) draft.autoDeleteTime = Number(autoDelete.value || 0)
    } else if (ui.createStep === 3) {
      const username = document.querySelector('#mg-create-username')
      const members = document.querySelector('#mg-create-members')
      if (username) draft.username = normalizeUsername(username.value)
      if (members) draft.members = members.value.trim()
    }
  }

  function validateCreateStep () {
    captureCreateStep()
    const draft = ui.createDraft
    if (ui.createStep === 2) {
      if (!draft.title || draft.title.length > 128) {
        toast('Title must be 1–128 characters', 'error')
        return false
      }
      if (draft.description.length > 255) {
        toast('Description must be at most 255 characters', 'error')
        return false
      }
    }
    if (ui.createStep === 3 && draft.visibility === 'public') {
      if (!draft.username || !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(draft.username)) {
        toast('Enter a valid public @username', 'error')
        return false
      }
    }
    return true
  }

  async function onCreateNext () {
    if (!validateCreateStep()) return
    if (ui.createStep < 4) {
      ui.createStep++
      renderCreateWizard()
      return
    }
    await createManagedChat()
  }

  function renderCreateWizard () {
    const body = document.querySelector('#mg-create-body')
    const progress = document.querySelector('#mg-create-progress')
    const back = document.querySelector('#mg-create-back')
    const next = document.querySelector('#mg-create-next')
    if (!body || !progress || !back || !next) return

    progress.innerHTML = ''
    const labels = ['Type', 'Details', 'Access', 'Review']
    labels.forEach((label, index) => {
      const item = elem('div', 'mg-progress-step' + (index + 1 <= ui.createStep ? ' active' : ''))
      item.append(elem('span', '', String(index + 1)), elem('small', '', label))
      progress.appendChild(item)
    })

    back.disabled = ui.createStep === 1
    next.textContent = ui.createStep === 4 ? 'Create' : 'Next'
    body.innerHTML = ''

    if (ui.createStep === 1) renderCreateType(body)
    else if (ui.createStep === 2) renderCreateDetails(body)
    else if (ui.createStep === 3) renderCreateAccess(body)
    else renderCreateReview(body)
  }

  function renderCreateType (body) {
    body.appendChild(elem('p', 'mg-step-copy', 'Choose what you want to create. Groups use Telegram supergroups so public usernames and modern management features are available.'))
    const choices = elem('div', 'mg-choice-grid')
    for (const option of [
      { type: 'channel', icon: '📣', title: 'Channel', copy: 'Broadcast updates to subscribers.' },
      { type: 'group', icon: '👥', title: 'Group', copy: 'Conversation space with members and admins.' }
    ]) {
      const card = button('', 'mg-choice-card' + (ui.createDraft.type === option.type ? ' selected' : ''), () => {
        ui.createDraft.type = option.type
        renderCreateWizard()
      })
      card.append(elem('span', 'mg-choice-icon', option.icon), elem('strong', '', option.title), elem('span', 'muted', option.copy))
      choices.appendChild(card)
    }
    body.appendChild(choices)
  }

  function renderCreateDetails (body) {
    const title = textInput(ui.createDraft.title, ui.createDraft.type === 'channel' ? 'Channel name' : 'Group name')
    title.id = 'mg-create-chat-title'
    const desc = textarea(ui.createDraft.description, 'Description (optional)')
    desc.id = 'mg-create-description'
    body.append(labelled('Title', title), labelled('Description', desc))

    const autoDelete = elem('select', 'mg-select')
    autoDelete.id = 'mg-create-auto-delete'
    for (const [seconds, label] of [[0, 'Off'], [86400, '1 day'], [604800, '1 week'], [2592000, '30 days'], [31536000, '1 year']]) {
      const o = elem('option', '', label)
      o.value = String(seconds)
      o.selected = Number(ui.createDraft.autoDeleteTime) === seconds
      autoDelete.appendChild(o)
    }
    body.appendChild(labelled('Message auto-delete', autoDelete))

    if (ui.createDraft.type === 'group') {
      const forumRow = elem('label', 'mg-toggle-row')
      const forum = elem('input', '')
      forum.type = 'checkbox'
      forum.id = 'mg-create-forum'
      forum.checked = ui.createDraft.forum
      forumRow.append(forum, elem('span', '', 'Forum / Topics enabled'))
      body.appendChild(forumRow)
    }
  }

  function renderCreateAccess (body) {
    body.appendChild(elem('p', 'mg-step-copy', 'Private chats use invite links. Public chats expose a Telegram @username.'))
    const visibility = elem('div', 'mg-segmented')
    for (const [value, label] of [['private', 'Private'], ['public', 'Public']]) {
      const b = button(label, ui.createDraft.visibility === value ? 'active' : '', () => {
        captureCreateStep()
        ui.createDraft.visibility = value
        if (value === 'private') ui.createDraft.username = ''
        renderCreateWizard()
      })
      visibility.appendChild(b)
    }
    body.appendChild(labelled('Visibility', visibility))

    if (ui.createDraft.visibility === 'public') {
      const username = textInput(ui.createDraft.username, 'username')
      username.id = 'mg-create-username'
      const prefix = elem('div', 'mg-username-field')
      prefix.append(elem('span', '', '@'), username)
      body.appendChild(labelled('Public username', prefix))
    }

    const members = textarea(ui.createDraft.members, '@alice, @bob (optional)')
    members.id = 'mg-create-members'
    members.rows = 3
    body.appendChild(labelled('Initial members by @username', members))
    body.appendChild(elem('span', 'mg-help', 'Up to 20 usernames. Telegram privacy restrictions may prevent some users from being added.'))
  }

  function renderCreateReview (body) {
    const d = ui.createDraft
    const review = elem('div', 'mg-review')
    const rows = [
      ['Type', d.type === 'channel' ? 'Channel' : (d.forum ? 'Forum group' : 'Group')],
      ['Title', d.title],
      ['Visibility', d.visibility === 'public' ? `Public · @${d.username}` : 'Private'],
      ['Auto-delete', formatAutoDelete(d.autoDeleteTime)],
      ['Initial members', String(parseMemberUsernames(d.members).length)]
    ]
    for (const [label, value] of rows) {
      const row = elem('div', 'mg-review-row')
      row.append(elem('span', 'muted', label), elem('strong', '', value || '—'))
      review.appendChild(row)
    }
    if (d.description) {
      review.appendChild(elem('div', 'mg-review-description', d.description))
    }
    body.appendChild(review)
    body.appendChild(elem('p', 'mg-step-copy', 'Tele will create the chat through TDLib, apply the requested username, add eligible members, then open the new chat automatically.'))
  }

  async function createManagedChat () {
    const next = document.querySelector('#mg-create-next')
    next.disabled = true
    next.textContent = 'Creating…'
    try {
      const d = ui.createDraft
      const result = await request('create-managed-chat', {
        type: d.type,
        title: d.title,
        description: d.description,
        visibility: d.visibility,
        username: d.visibility === 'public' ? d.username : '',
        forum: d.type === 'group' && d.forum,
        autoDeleteTime: Number(d.autoDeleteTime || 0),
        memberUsernames: parseMemberUsernames(d.members)
      })
      closeCreateWizard()
      if (result.warnings && result.warnings.length) toast(result.warnings.join(' · '), 'error')
      else toastOk(`${d.type === 'channel' ? 'Channel' : 'Group'} created`)
      await loadChats().catch(() => {})
      if (result.chat && result.chat.id != null) {
        await openChat(result.chat.id)
        showDrawer('info')
      }
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      next.disabled = false
      next.textContent = 'Create'
    }
  }

  /* ------------------------------ Chat info ------------------------------ */

  async function refreshChatInfo () {
    const panel = document.querySelector('#mg-info-pane')
    if (!panel) return
    if (state.activeChatId == null) {
      ui.info = null
      panel.innerHTML = ''
      panel.appendChild(emptyInfoState())
      return
    }

    const generation = ++ui.infoGeneration
    panel.innerHTML = '<div class="mg-info-loading">Loading chat info…</div>'
    try {
      const data = await request('get-chat-management', { chatId: state.activeChatId })
      if (generation !== ui.infoGeneration || String(state.activeChatId) !== String(data.chat.id)) return
      ui.info = data
      renderChatInfo(data)
    } catch (e) {
      if (generation !== ui.infoGeneration) return
      panel.innerHTML = ''
      const error = elem('div', 'mg-empty')
      error.append(elem('strong', '', 'Could not load chat info'), elem('span', 'muted', e.message))
      error.appendChild(button('Retry', 'ghost', refreshChatInfo))
      panel.appendChild(error)
    }
  }

  function renderChatInfo (data) {
    const panel = document.querySelector('#mg-info-pane')
    if (!panel) return
    panel.innerHTML = ''
    const { chat, details, permissions } = data

    const hero = elem('div', 'mg-info-hero')
    const avatar = elem('div', 'mg-info-avatar', initials(chat.title))
    avatar.style.background = avatarColor(chat.title)
    if (chat.photoFileId) loadInfoAvatar(chat, avatar)
    const titleBox = elem('div', 'mg-info-title')
    titleBox.append(elem('h3', '', chat.title), elem('span', 'muted', chat.username ? `@${chat.username}` : formatKind(chat.kind)))
    hero.append(avatar, titleBox)
    panel.appendChild(hero)

    const overview = section('Overview')
    overview.append(
      infoRow('Type', formatKind(chat.kind)),
      infoRow('Access', chat.username ? 'Public' : (chat.kind === 'private' ? 'Private chat' : 'Private')),
      infoRow('Members', details.memberCount != null ? String(details.memberCount) : '—'),
      infoRow('Your role', details.statusLabel || 'Member'),
      infoRow('Auto-delete', formatAutoDelete(details.autoDeleteTime)),
      infoRow('Notifications', details.muted ? 'Muted' : 'On')
    )
    panel.appendChild(overview)

    if (permissions.canChangeInfo) panel.appendChild(renderEditSection(data))
    else if (details.description) {
      const description = section('Description')
      description.appendChild(elem('p', 'mg-description', details.description))
      panel.appendChild(description)
    }

    if (chat.kind !== 'private') panel.appendChild(renderInviteSection(data))
    if (chat.kind !== 'private' && permissions.canGetMembers) panel.appendChild(renderMembersSection(data))
    panel.appendChild(renderNotificationSection(data))
    if (chat.kind !== 'private') panel.appendChild(renderDangerSection(data))
  }

  function section (title) {
    const box = elem('section', 'mg-section')
    box.appendChild(elem('h4', '', title))
    return box
  }

  function infoRow (label, value) {
    const row = elem('div', 'mg-info-row')
    row.append(elem('span', 'muted', label), elem('span', '', value == null ? '—' : String(value)))
    return row
  }

  async function loadInfoAvatar (chat, holder) {
    try {
      const r = await request('get-thumb', { fileId: chat.photoFileId })
      if (!r.path || String(state.activeChatId) !== String(chat.id)) return
      holder.textContent = ''
      const img = elem('img', '')
      img.src = '/dl' + r.path
      img.alt = ''
      holder.appendChild(img)
    } catch {}
  }

  function renderEditSection (data) {
    const { chat, details, permissions } = data
    const box = section('Edit chat')
    const title = textInput(chat.title, 'Title')
    const description = textarea(details.description || '', 'Description')
    const autoDelete = elem('select', 'mg-select')
    for (const [seconds, label] of [[0, 'Off'], [86400, '1 day'], [604800, '1 week'], [2592000, '30 days'], [31536000, '1 year']]) {
      const o = elem('option', '', label)
      o.value = String(seconds)
      o.selected = Number(details.autoDeleteTime || 0) === seconds
      autoDelete.appendChild(o)
    }
    box.append(labelled('Title', title), labelled('Description', description), labelled('Auto-delete', autoDelete))

    let username = null
    if (permissions.canEditUsername) {
      username = textInput(chat.username || '', 'username or blank for private')
      const prefix = elem('div', 'mg-username-field')
      prefix.append(elem('span', '', '@'), username)
      box.appendChild(labelled('Public username', prefix))
    }

    const actions = elem('div', 'mg-row')
    const save = button('Save changes', '', async () => {
      save.disabled = true
      try {
        await request('update-managed-chat', {
          chatId: chat.id,
          title: title.value.trim(),
          description: description.value.trim(),
          username: username ? normalizeUsername(username.value) : undefined,
          autoDeleteTime: Number(autoDelete.value || 0)
        })
        toastOk('Chat settings updated')
        await loadChats().catch(() => {})
        await refreshChatInfo()
      } catch (e) { toast(e.message, 'error') } finally { save.disabled = false }
    })
    actions.appendChild(save)
    box.appendChild(actions)

    if (permissions.canSetPhoto) {
      const photoTools = elem('div', 'mg-photo-tools')
      const file = elem('input', 'mg-file-input')
      file.type = 'file'
      file.accept = '.jpg,.jpeg,image/jpeg'
      const upload = button('Set photo', 'ghost', async () => {
        const selected = file.files && file.files[0]
        if (!selected) return toast('Choose a JPEG image first', 'error')
        upload.disabled = true
        try {
          const res = await fetch(`/api/chat-photo/${encodeURIComponent(chat.id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': selected.name },
            body: selected
          })
          const json = await res.json()
          if (!res.ok) throw new Error(json.error || 'Photo update failed')
          toastOk('Chat photo updated')
          await loadChats().catch(() => {})
          await refreshChatInfo()
        } catch (e) { toast(e.message, 'error') } finally { upload.disabled = false }
      })
      const remove = button('Remove photo', 'ghost danger-outline', async () => {
        if (!await confirmAction('Remove chat photo?', 'The current chat photo will be removed.', 'Remove')) return
        try {
          await request('remove-managed-photo', { chatId: chat.id })
          toastOk('Chat photo removed')
          await loadChats().catch(() => {})
          await refreshChatInfo()
        } catch (e) { toast(e.message, 'error') }
      })
      photoTools.append(file, upload, remove)
      box.appendChild(labelled('Chat photo', photoTools))
    }
    return box
  }

  function renderInviteSection (data) {
    const { chat, details, permissions } = data
    const box = section('Invite link')
    const linkRow = elem('div', 'mg-invite-row')
    const value = elem('div', 'mg-invite-value', details.inviteLink || 'No invite link loaded')
    value.title = details.inviteLink || ''
    linkRow.appendChild(value)
    if (details.inviteLink) {
      linkRow.appendChild(button('Copy', 'ghost small', () => copyText(details.inviteLink, 'Invite link copied')))
    }
    if (!details.inviteLink && permissions.canInviteUsers) {
      linkRow.appendChild(button('Create link', 'ghost small', async e => {
        e.currentTarget.disabled = true
        try {
          const r = await request('create-managed-invite', { chatId: chat.id })
          if (r.inviteLink) copyText(r.inviteLink, 'Invite link created and copied')
          await refreshChatInfo()
        } catch (err) { toast(err.message, 'error') } finally { e.currentTarget.disabled = false }
      }))
    }
    box.appendChild(linkRow)
    return box
  }

  function renderMembersSection (data) {
    const { chat, permissions } = data
    const box = section('Members')
    if (permissions.canInviteUsers) {
      const add = elem('div', 'mg-member-add')
      const input = textInput('', '@username')
      const addButton = button('Add', '', async () => {
        const username = normalizeUsername(input.value)
        if (!username) return
        addButton.disabled = true
        try {
          await request('add-managed-member', { chatId: chat.id, username })
          toastOk(`Added @${username}`)
          input.value = ''
          await refreshChatInfo()
        } catch (e) { toast(e.message, 'error') } finally { addButton.disabled = false }
      })
      add.append(input, addButton)
      box.appendChild(add)
    }

    const memberList = elem('div', 'mg-member-list')
    memberList.id = 'mg-member-list'
    const load = button('Load members', 'ghost', () => loadMembers(data, memberList, load))
    box.append(load, memberList)
    return box
  }

  async function loadMembers (data, list, loadButton) {
    if (ui.memberLoading) return
    ui.memberLoading = true
    loadButton.disabled = true
    loadButton.textContent = 'Loading…'
    list.innerHTML = ''
    try {
      const r = await request('get-managed-members', { chatId: data.chat.id, limit: 100 })
      loadButton.textContent = `Refresh members (${r.totalCount || r.members.length})`
      for (const member of r.members || []) {
        const row = elem('div', 'mg-member-row')
        const avatar = elem('div', 'mg-member-avatar', initials(member.name || member.username || '?'))
        avatar.style.background = avatarColor(member.name || member.username || '?')
        const meta = elem('div', 'mg-member-meta')
        meta.append(elem('strong', '', member.name || 'Unknown'), elem('span', 'muted', member.username ? `@${member.username} · ${member.statusLabel}` : member.statusLabel))
        row.append(avatar, meta)
        if (data.permissions.canRestrictMembers && !member.isSelf && member.userId) {
          const remove = button('Remove', 'ghost small danger-outline', async () => {
            if (!await confirmAction('Remove member?', `${member.name || member.username || 'This member'} will be removed from the chat.`, 'Remove')) return
            remove.disabled = true
            try {
              await request('remove-managed-member', { chatId: data.chat.id, userId: member.userId })
              toastOk('Member removed')
              row.remove()
            } catch (e) { toast(e.message, 'error') } finally { remove.disabled = false }
          })
          row.appendChild(remove)
        }
        list.appendChild(row)
      }
      if (!list.children.length) list.appendChild(elem('div', 'mg-help', 'No members returned by Telegram.'))
    } catch (e) {
      list.appendChild(elem('div', 'mg-help', e.message))
    } finally {
      ui.memberLoading = false
      loadButton.disabled = false
    }
  }

  function renderNotificationSection (data) {
    const { chat, details, permissions } = data
    const box = section('Notifications')
    const row = elem('div', 'mg-setting-row')
    const text = elem('div', '')
    text.append(elem('strong', '', details.muted ? 'Muted' : 'Notifications on'), elem('span', 'muted', details.muted ? 'Tele will unmute this chat.' : 'Mute this chat until you turn notifications back on.'))
    row.appendChild(text)
    const toggle = button(details.muted ? 'Unmute' : 'Mute', 'ghost', async () => {
      if (!permissions.canMute) return
      toggle.disabled = true
      try {
        await request('set-managed-muted', { chatId: chat.id, muted: !details.muted })
        await refreshChatInfo()
      } catch (e) { toast(e.message, 'error') } finally { toggle.disabled = false }
    })
    toggle.disabled = !permissions.canMute
    row.appendChild(toggle)
    box.appendChild(row)
    return box
  }

  function renderDangerSection (data) {
    const { chat, permissions } = data
    const box = section('Danger zone')
    box.classList.add('mg-danger-section')

    if (permissions.canClearHistory) {
      const clearSelf = button('Clear history', 'ghost danger-outline', async () => {
        if (!await confirmAction('Clear chat history?', 'Messages will be removed from your history. This cannot be undone.', 'Clear history')) return
        try {
          await request('clear-managed-history', { chatId: chat.id, revoke: false })
          state.messages = []
          renderMessagesList()
          renderFiles()
          toastOk('Chat history cleared')
        } catch (e) { toast(e.message, 'error') }
      })
      box.appendChild(clearSelf)
    }

    if (permissions.canLeave) {
      const leave = button('Leave chat', 'ghost danger-outline', async () => {
        if (!await confirmAction(`Leave ${chat.title}?`, 'You will be removed from this group/channel.', 'Leave')) return
        try {
          await request('leave-managed-chat', { chatId: chat.id })
          toastOk('Left chat')
          showDrawer('downloads')
        } catch (e) { toast(e.message, 'error') }
      })
      box.appendChild(leave)
    }

    if (permissions.canDeleteForAll) {
      const del = button('Delete for everyone', 'danger', async () => {
        if (!await confirmAction(`Delete ${chat.title}?`, 'This permanently deletes the chat and its messages for all members where Telegram permits it.', 'Delete permanently')) return
        try {
          await request('delete-managed-chat', { chatId: chat.id })
          toastOk('Chat deleted')
          showDrawer('downloads')
        } catch (e) { toast(e.message, 'error') }
      })
      box.appendChild(del)
    }

    if (!permissions.canClearHistory && !permissions.canLeave && !permissions.canDeleteForAll) {
      box.appendChild(elem('div', 'mg-help', 'Telegram does not expose destructive actions for your current role.'))
    }
    return box
  }

  function copyText (value, message) {
    if (!value) return
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(() => toastOk(message || 'Copied')).catch(() => toast('Copy failed', 'error'))
      return
    }
    const ta = elem('textarea', '')
    ta.value = value
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy'); toastOk(message || 'Copied') } catch { toast('Copy failed', 'error') }
    ta.remove()
  }

  /* ------------------------------ In-app confirmations ------------------------------ */

  function ensureConfirmModal () {
    let modal = document.querySelector('#mg-confirm-modal')
    if (modal) return modal
    modal = elem('div', 'mg-modal hidden')
    modal.id = 'mg-confirm-modal'
    modal.innerHTML = `
      <div class="mg-dialog mg-confirm-dialog" role="alertdialog" aria-modal="true">
        <div class="mg-dialog-head"><h2 id="mg-confirm-title">Confirm</h2></div>
        <p id="mg-confirm-text" class="mg-confirm-text"></p>
        <div class="mg-dialog-foot">
          <button id="mg-confirm-cancel" class="ghost" type="button">Cancel</button>
          <div class="mg-dialog-foot-spacer"></div>
          <button id="mg-confirm-ok" class="danger" type="button">Confirm</button>
        </div>
      </div>`
    document.body.appendChild(modal)
    return modal
  }

  function confirmAction (title, text, confirmText) {
    const modal = ensureConfirmModal()
    document.querySelector('#mg-confirm-title').textContent = title
    document.querySelector('#mg-confirm-text').textContent = text
    const ok = document.querySelector('#mg-confirm-ok')
    ok.textContent = confirmText || 'Confirm'
    modal.classList.remove('hidden')
    return new Promise(resolve => {
      const finish = value => {
        modal.classList.add('hidden')
        ok.onclick = null
        cancel.onclick = null
        resolve(value)
      }
      const cancel = document.querySelector('#mg-confirm-cancel')
      ok.onclick = () => finish(true)
      cancel.onclick = () => finish(false)
      modal.onmousedown = e => { if (e.target === modal) finish(false) }
    })
  }

  /* ------------------------------ Existing runtime integration ------------------------------ */

  function wrapExistingRuntime () {
    if (typeof openChat === 'function' && !openChat.__managementWrapped) {
      const base = openChat
      const wrapped = async function managementOpenChat (chatId) {
        const result = await base(chatId)
        if (ui.drawerMode === 'info') refreshChatInfo()
        return result
      }
      wrapped.__managementWrapped = true
      openChat = wrapped
    }

    if (typeof upsertChat === 'function' && !upsertChat.__managementWrapped) {
      const base = upsertChat
      const wrapped = function managementUpsertChat (chat) {
        const result = base(chat)
        if (ui.drawerMode === 'info' && state.activeChatId != null && chat && String(chat.id) === String(state.activeChatId)) {
          setTimeout(refreshChatInfo, 150)
        }
        return result
      }
      wrapped.__managementWrapped = true
      upsertChat = wrapped
    }

    if (typeof removeChat === 'function' && !removeChat.__managementWrapped) {
      const base = removeChat
      const wrapped = function managementRemoveChat (chatId) {
        const active = state.activeChatId != null && String(state.activeChatId) === String(chatId)
        const result = base(chatId)
        if (active) {
          ui.info = null
          const panel = document.querySelector('#mg-info-pane')
          if (panel) { panel.innerHTML = ''; panel.appendChild(emptyInfoState()) }
        }
        return result
      }
      wrapped.__managementWrapped = true
      removeChat = wrapped
    }
  }

  mountDrawer()
  mountEntryPoints()
  wrapExistingRuntime()

  if (ui.drawerMode === 'info' && state.activeChatId != null) refreshChatInfo()
})()
