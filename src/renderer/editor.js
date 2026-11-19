'use strict';

(() => {
  function validateTrim(start, end, total) {
    if (![start, end, total].every(Number.isFinite) || start < 0 || end <= start || end > total) return null;
    return { start, end, duration: end - start };
  }

  function markerRange(time, total, target) {
    if (![time, total, target].every(Number.isFinite) || total <= 0 || target <= 0) return null;
    const length = Math.min(total, target);
    const start = Math.min(total - length, Math.max(0, time - length * 0.35));
    return validateTrim(start, Math.min(total, start + length), total);
  }

  function clock(seconds) {
    const deciseconds = Math.max(0, Math.floor(seconds * 10));
    const minutes = Math.floor(deciseconds / 600);
    return `${minutes}:${String(Math.floor(deciseconds / 10) % 60).padStart(2, '0')}.${deciseconds % 10}`;
  }

  function createClipEditor({ fileUrl, onMark, onTrim, onCrop, onRender, onPreview }) {
    const $ = (id) => document.getElementById(id);
    const panel = $('editorPanel');
    const player = $('editorVideo');
    const backdrop = $('editorBackdrop');
    const seek = $('editorSeek');
    const play = $('editorPlay');
    const proxy = $('editorProxy');
    const crop = $('editorCrop');
    const inputStart = $('editorIn');
    const inputEnd = $('editorOut');
    let source;
    let clip;
    let media;
    let settings = {};
    let gameplay = false;
    let position = 0;
    let mediaError = false;
    let previewBusy = false;
    const renderRanges = new Map();

    function status(message = '', error = false) {
      $('editorStatus').textContent = message;
      $('editorStatus').classList.toggle('error', error);
    }

    function timeline(kind = media?.kind) {
      return kind === 'render' ? media : { start: clip?.start ?? 0, end: clip?.end ?? source.duration };
    }

    function rememberRender(item) {
      if (item.outputPath && !item.needsRender) {
        renderRanges.set(item.outputPath, { start: item.start, end: item.end });
      }
    }

    function setPosition(time, kind) {
      if (!source) return;
      const { start, end } = timeline(kind);
      position = Math.min(end, Math.max(start, time));
      seek.min = start;
      seek.max = end;
      seek.value = position;
      seek.setAttribute('aria-valuetext', clock(position));
      $('editorTime').textContent = `${clock(position)} / ${clock(end)}`;
    }

    function updateControls() {
      const isClip = Boolean(clip);
      $('editorInspector').classList.toggle('hidden', !isClip);
      $('editorLayout').classList.toggle('has-clip', isClip);
      $('editorSource').classList.toggle('hidden', !isClip);
      $('editorTitle').textContent = isClip ? `Edit clip ${clip.index + 1}` : 'Source preview';
      $('editorMark').classList.toggle('hidden', !gameplay || isClip);
      $('editorRender').textContent = clip?.outputPath ? 'Rerender clip' : 'Render clip';
      $('editorPlayRender').classList.toggle('hidden', !clip?.outputPath);
      $('editorPlayRender').textContent = clip?.needsRender ? 'Play previous render' : 'Play render';
      play.disabled = mediaError || media?.loading || player.readyState < 1;
    }

    function updateFrame() {
      if (!source) return;
      const needsAudioProxy = Number(settings.audioTrack) > 0 || settings.audioTrack === 'mix';
      const stage = $('editorStage');
      let ratio = source.width / source.height || 16 / 9;
      if (clip && settings.aspectRatio !== 'original') {
        const [w, h] = String(settings.aspectRatio).split(':').map(Number);
        if (w && h) ratio = w / h;
      }
      const fills = clip && settings.aspectRatio !== 'original' && ['crop', 'smart'].includes(settings.reframeMode);
      const alreadyFramed = media?.kind === 'render';
      stage.style.aspectRatio = ratio;
      stage.style.width = `min(100%, ${Math.min(540, 390 * ratio)}px)`;
      stage.classList.toggle('is-cropped', Boolean(fills && !alreadyFramed));
      const padded = clip && settings.aspectRatio !== 'original' && settings.reframeMode === 'blur' && !alreadyFramed;
      backdrop.classList.toggle('hidden', !padded);
      if (padded) {
        const height = Math.min(200, Math.round(80 / ratio));
        if (backdrop.width !== 80 || backdrop.height !== height) {
          backdrop.width = 80;
          backdrop.height = height;
        }
        drawBackdrop();
      }
      const bias = Number(crop.value);
      player.style.objectPosition = `${(bias + 1) * 50}% 50%`;
      player.muted = settings.audioTrack === 'none' || (media?.kind === 'source' && needsAudioProxy);
      $('editorCropField').classList.toggle('hidden', !fills);
      $('editorCropValue').textContent = bias === 0 ? 'Center' : `${Math.round(Math.abs(bias) * 100)}% ${bias < 0 ? 'left' : 'right'}`;
      $('editorCaptionGuide').classList.toggle('hidden', !clip || !$('editorSafeZone').checked);
      const showProxy = mediaError || (media?.kind === 'source' && needsAudioProxy) || media?.kind === 'proxy';
      proxy.classList.toggle('hidden', !showProxy);
      proxy.disabled = previewBusy;
      proxy.textContent = needsAudioProxy && !mediaError ? 'Preview selected audio' : 'Generate playback preview';
    }

    function drawBackdrop() {
      if (backdrop.classList.contains('hidden') || player.readyState < 2 || !player.videoWidth) return;
      const { width, height } = backdrop;
      const scale = Math.max(width / player.videoWidth, height / player.videoHeight) * 1.12;
      const w = player.videoWidth * scale;
      const h = player.videoHeight * scale;
      const context = backdrop.getContext('2d');
      context.filter = 'blur(5px)';
      context.drawImage(player, (width - w) / 2, (height - h) / 2, w, h);
    }

    function syncPlayback() {
      if (!media || mediaError || player.readyState < 1) return;
      if (position < media.start || position > media.end) {
        player.pause();
        status('Generate a playback preview at this position.');
        return;
      }
      player.currentTime = Math.max(0, position - media.start);
    }

    async function load(path, kind, start, end) {
      player.pause();
      const sameSource = media?.path === path && media.kind === kind;
      if (!sameSource) {
        const pending = { path, kind, start, end, loading: true };
        media = pending;
        if (kind === 'render') setPosition(start);
        mediaError = false;
        updateControls();
        try {
          const url = await fileUrl(path);
          if (media !== pending) return false;
          pending.loading = false;
          player.src = url;
        } catch (error) {
          if (media !== pending) return false;
          mediaError = true;
          status(`Could not load playback. ${error.message}`, true);
        }
      } else if (mediaError) {
        showPlaybackError();
      }
      syncPlayback();
      updateControls();
      updateFrame();
      return !mediaError;
    }

    function showSource() {
      if (!source) return;
      clip = null;
      status();
      setPosition(position, 'source');
      load(source.path, 'source', 0, source.duration);
    }

    function checkTrim() {
      if (!clip) return null;
      const range = validateTrim(inputStart.valueAsNumber, inputEnd.valueAsNumber, source.duration);
      $('editorValidation').textContent = range
        ? `${range.duration.toFixed(2)} seconds`
        : `Use a start before the end, within 0–${source.duration.toFixed(3)} seconds.`;
      $('editorValidation').classList.toggle('error', !range);
      inputStart.setAttribute('aria-invalid', String(!range));
      inputEnd.setAttribute('aria-invalid', String(!range));
      $('editorRender').disabled = !range;
      return range;
    }

    function commitTrim() {
      const range = checkTrim();
      if (!range || (range.start === clip.start && range.end === clip.end)) return;
      clip = onTrim(clip.index, range);
      setPosition(position, 'source');
      status();
      load(source.path, 'source', 0, source.duration);
    }

    play.addEventListener('click', () => {
      if (!player.paused) { player.pause(); return; }
      const { start, end } = timeline();
      if (position >= end) setPosition(start);
      if (position < media.start || position >= media.end) { syncPlayback(); return; }
      syncPlayback();
      player.play().catch((error) => {
        if (error.name !== 'AbortError') showPlaybackError();
      });
    });
    player.addEventListener('loadedmetadata', () => {
      if (!source) return;
      mediaError = false;
      status(media.kind === 'proxy' ? `Preview available from ${clock(media.start)} to ${clock(media.end)}.` : '');
      syncPlayback();
      updateControls();
      updateFrame();
    });
    function showPlaybackError() {
      if (!source) return;
      mediaError = true;
      status('Direct playback is unavailable. Use the seek bar to choose a position, then generate a playback preview.', true);
      updateControls();
      updateFrame();
    }
    player.addEventListener('error', showPlaybackError);
    player.addEventListener('loadeddata', drawBackdrop);
    player.addEventListener('seeked', drawBackdrop);
    player.addEventListener('play', () => { play.textContent = 'Pause'; });
    player.addEventListener('pause', () => { play.textContent = 'Play'; });
    player.addEventListener('timeupdate', () => {
      drawBackdrop();
      if (!source || !media || mediaError || player.paused) return;
      const time = player.currentTime + media.start;
      if (time >= timeline().end || time >= media.end) player.pause();
      setPosition(time);
    });
    player.addEventListener('ended', () => { if (media) setPosition(media.end); });
    seek.addEventListener('input', () => { setPosition(Number(seek.value)); syncPlayback(); });
    $('editorSource').addEventListener('click', showSource);
    $('editorMark').addEventListener('click', () => { player.pause(); onMark(position); });
    for (const input of [inputStart, inputEnd]) {
      input.addEventListener('input', checkTrim);
      input.addEventListener('change', commitTrim);
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') commitTrim(); });
    }
    crop.addEventListener('input', () => {
      if (!clip) return;
      clip = onCrop(clip.index, Number(crop.value));
      if (media?.kind === 'render') {
        setPosition(position, 'source');
        load(source.path, 'source', 0, source.duration);
      }
      updateControls();
      updateFrame();
    });
    $('editorSafeZone').addEventListener('change', updateFrame);
    $('editorRender').addEventListener('click', () => {
      commitTrim();
      if (checkTrim()) { player.pause(); onRender(clip.index); }
    });
    $('editorPlayRender').addEventListener('click', async () => {
      if (!clip?.outputPath) return;
      const { start, end } = renderRanges.get(clip.outputPath) || clip;
      if (await load(clip.outputPath, 'render', start, end)) player.play().catch(() => {});
    });
    proxy.addEventListener('click', async () => {
      if (!source || previewBusy) return;
      const requestedSource = source;
      const requestedClip = clip;
      const segment = clip || markerRange(position, source.duration, 24);
      if (!segment) return;
      previewBusy = true;
      player.pause();
      updateFrame();
      status('Generating a playback preview…');
      try {
        const result = await onPreview(segment);
        if (source !== requestedSource || clip !== requestedClip) return;
        if (result?.outputPath) load(result.outputPath, 'proxy', segment.start, segment.end);
        else status('Playback preview cancelled.');
      } catch (error) {
        if (source === requestedSource) status(`Preview failed. ${error.message}`, true);
      } finally {
        previewBusy = false;
        updateFrame();
      }
    });

    return {
      setSource(nextSource) {
        player.pause();
        source = nextSource;
        renderRanges.clear();
        panel.classList.toggle('hidden', !source);
        if (!source) {
          media = null;
          player.removeAttribute('src');
          player.load();
          return;
        }
        position = 0;
        showSource();
      },
      review(nextClip) {
        if (!source) return;
        clip = nextClip;
        rememberRender(clip);
        inputStart.max = source.duration;
        inputEnd.max = source.duration;
        inputStart.value = clip.start;
        inputEnd.value = clip.end;
        crop.value = clip.cropBias ?? 0;
        checkTrim();
        status();
        setPosition(clip.start, 'source');
        load(source.path, 'source', 0, source.duration);
        panel.scrollIntoView({ block: 'start' });
        $('editorTitle').focus({ preventScroll: true });
      },
      refreshClip(nextClip) {
        rememberRender(nextClip);
        if (!clip || clip.index !== nextClip.index) return;
        clip = nextClip;
        crop.value = clip.cropBias ?? 0;
        updateControls();
        updateFrame();
      },
      configure(nextSettings, isGameplay) {
        const audioChanged = settings.audioTrack !== nextSettings.audioTrack;
        settings = nextSettings;
        gameplay = isGameplay;
        if (audioChanged && source && media?.kind === 'proxy') load(source.path, 'source', 0, source.duration);
        updateControls();
        updateFrame();
      },
      showSource,
    };
  }

  if (typeof module !== 'undefined') module.exports = { validateTrim, markerRange };
  if (typeof window !== 'undefined') window.shortForgeEditor = { createClipEditor, markerRange };
})();
