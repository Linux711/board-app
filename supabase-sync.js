/* Supabase connection for Fieldnotes shared boards.
 * The publishable key is intended for browser use. Access is enforced by RLS
 * and the private invite token, never by keeping this key secret.
 */
(() => {
  const SUPABASE_URL = 'https://ohqmmmzoryjmqnxwxrgb.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_jUC8EVlmcHSpFIIkm4W5Yw_aE-kU6Fh';
  const STORAGE_KEY = 'fieldnotes-shared-board-v1';
  const BUCKET = 'fieldnotes-images';

  const client = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY
  );

  let boardId = null;
  let inviteToken = null;
  let saveTimer = null;
  let channel = null;
  let lastSavedDocument = '';
  const uploadedImages = new Map();

  const boardApi = () => window.fieldnotesBoard;
  const toast = (message) => boardApi()?.showToast(message);
  const localConnection = () => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch {
      return null;
    }
  };
  const rememberConnection = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ boardId, inviteToken }));
  };

  async function ensureAnonymousSession() {
    const { data: { session }, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    if (session) return;

    const { error } = await client.auth.signInAnonymously();
    if (error) throw error;
  }

  function imageExtension(dataUrl) {
    const mime = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/i)?.[1];
    const extension = mime?.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    return { mime: mime || 'image/png', extension };
  }

  async function uploadImage(card, id) {
    const { mime, extension } = imageExtension(card.image);
    const path = `${boardId}/${id}/image.${extension}`;
    const response = await fetch(card.image);
    const file = await response.blob();
    const { error } = await client.storage.from(BUCKET).upload(path, file, {
      contentType: mime,
      upsert: true
    });
    if (error) throw error;
    return path;
  }

  async function documentForCloud(state) {
    const document = structuredClone(state);
    for (const project of document.projects || []) {
      for (const card of project.cards || []) {
        if (card.image?.startsWith('data:image/')) {
          const cacheKey = `${card.id}:${card.image}`;
          let path = uploadedImages.get(cacheKey);
          if (!path) {
            path = await uploadImage(card, card.id);
            uploadedImages.set(cacheKey, path);
          }
          card.imagePath = path;
          card.image = '';
        } else if (card.imagePath) {
          card.image = '';
        }
      }
    }
    return document;
  }

  async function stateFromCloud(document) {
    const state = structuredClone(document);
    for (const project of state.projects || []) {
      for (const card of project.cards || []) {
        if (!card.imagePath) continue;
        const { data, error } = await client.storage
          .from(BUCKET)
          .createSignedUrl(card.imagePath, 60 * 60);
        if (error) throw error;
        const response = await fetch(data.signedUrl);
        if (!response.ok) throw new Error('Could not load a board image');
        const imageBlob = await response.blob();
        card.image = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(imageBlob);
        });
        uploadedImages.set(`${card.id}:${card.image}`, card.imagePath);
      }
    }
    return state;
  }

  async function loadBoard(id, token) {
    await ensureAnonymousSession();
    const { data: joined, error: joinError } = await client.rpc('join_shared_board', {
      requested_board_id: id,
      supplied_invite_token: token
    });
    if (joinError) throw joinError;
    if (!joined) throw new Error('That sharing link is invalid or has been replaced.');

    const { data: board, error } = await client
      .from('boards')
      .select('document')
      .eq('id', id)
      .single();
    if (error) throw error;

    boardId = id;
    inviteToken = token;
    rememberConnection();
    const state = await stateFromCloud(board.document);
    lastSavedDocument = JSON.stringify(board.document);
    boardApi()?.replaceState(state);
    subscribeToBoard();
  }

  async function createBoard() {
    await ensureAnonymousSession();
    const localState = boardApi().getState();
    const document = await documentForCloud(localState);
    const activeProject = localState.projects.find((project) => project.id === localState.active)
      || localState.projects[0];
    const { data, error } = await client.rpc('create_shared_board', {
      board_name: activeProject?.name || 'Shared board',
      initial_document: document
    });
    if (error) throw error;

    boardId = data[0].board_id;
    inviteToken = data[0].invite_token;
    rememberConnection();
    lastSavedDocument = JSON.stringify(document);
    subscribeToBoard();
  }

  function subscribeToBoard() {
    if (channel) client.removeChannel(channel);
    channel = client
      .channel(`fieldnotes-board-${boardId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'boards',
        filter: `id=eq.${boardId}`
      }, async (event) => {
        const incoming = JSON.stringify(event.new.document);
        if (incoming === lastSavedDocument) return;
        try {
          const state = await stateFromCloud(event.new.document);
          lastSavedDocument = incoming;
          boardApi()?.replaceState(state);
        } catch (error) {
          console.error('Could not sync the latest board update:', error);
        }
      })
      .subscribe();
  }

  async function syncLatestState(state) {
    if (!boardId) return;
    const document = await documentForCloud(state);
    const serialized = JSON.stringify(document);
    if (serialized === lastSavedDocument) return;

    const activeProject = state.projects.find((project) => project.id === state.active)
      || state.projects[0];
    const { error } = await client
      .from('boards')
      .update({ name: activeProject?.name || 'Shared board', document })
      .eq('id', boardId);
    if (error) throw error;
    lastSavedDocument = serialized;
  }

  function schedule(state) {
    if (!boardId) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      syncLatestState(state).catch((error) => {
        console.error('Board sync failed:', error);
        toast('Could not sync right now. Your edits are still saved on this device.');
      });
    }, 700);
  }

  async function handleShare() {
    try {
      if (!boardId) await createBoard();

      const shareUrl = new URL(location.href);
      shareUrl.search = '';
      shareUrl.searchParams.set('board', boardId);
      shareUrl.searchParams.set('invite', inviteToken);

      const isLocalFile = location.protocol === 'file:';
      const panel = document.querySelector('#sharePanel');
      document.querySelector('#shareInstructions').textContent = isLocalFile
        ? 'Your board is saved online. Since this app is still a file on your computer, friends cannot open it yet. After the app is hosted, add these link details to its web address, open that address, then copy the full link to invite friends.'
        : 'Anyone with this private link can view and edit the board.';
      document.querySelector('#shareUrl').value = isLocalFile
        ? `${shareUrl.search}`
        : shareUrl.toString();
      panel.hidden = false;

      if (!isLocalFile) history.replaceState({}, '', shareUrl);
      toast(isLocalFile ? 'Board saved online' : 'Your sharing link is ready');
    } catch (error) {
      console.error('Could not create a sharing link:', error);
      toast(error.message || 'Could not connect to Supabase. Check the setup and try again.');
    }
  }

  async function initialize() {
    const button = document.querySelector('#shareBoardBtn');
    button?.addEventListener('click', handleShare);
    document.querySelector('#closeSharePanel')?.addEventListener('click', () => {
      document.querySelector('#sharePanel').hidden = true;
    });
    document.querySelector('#copyShareUrl')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(document.querySelector('#shareUrl').value);
        toast('Link copied');
      } catch {
        document.querySelector('#shareUrl').select();
        toast('Select and copy the link');
      }
    });

    try {
      const params = new URLSearchParams(location.search);
      const linkBoardId = params.get('board');
      const linkToken = params.get('invite');
      const saved = localConnection();

      if (linkBoardId && linkToken) {
        await loadBoard(linkBoardId, linkToken);
      } else if (saved?.boardId && saved?.inviteToken) {
        await loadBoard(saved.boardId, saved.inviteToken);
      }
    } catch (error) {
      console.error('Could not connect to the shared board:', error);
      toast(error.message || 'Could not load the shared board.');
    }
  }

  window.fieldnotesSync = { schedule };
  if (boardApi()) initialize();
  else window.addEventListener('fieldnotes:ready', initialize, { once: true });
})();
