// Set youtubeId in video-config.json after uploading the film to YouTube.
try {
  const response = await fetch('video-config.json');
  if (!response.ok) throw Error('Video configuration could not be loaded.');
  const config = await response.json();
  if (config.youtubeId && /^[A-Za-z0-9_-]{11}$/.test(config.youtubeId)) {
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${config.youtubeId}`;
    frame.title = 'FReSH project video';
    frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    frame.allowFullscreen = true;
    frame.loading = 'lazy';
    document.querySelector('#project-video').replaceChildren(frame);
  }
} catch (error) { console.warn(error.message); }
