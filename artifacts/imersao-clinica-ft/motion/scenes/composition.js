/* As telas são imagens e vídeos reais; só a câmera e as legendas de procedência são animadas. */
function composeFilm(scenes) {
  const duration = scenes.reduce((sum, scene) => sum + scene.duration, 0);
  const M = Motion.film({ fps: 30, duration, width: 1920, height: 1080, clock: 'smooth' });
  let cursor = 0;
  for (const scene of scenes) {
    const sceneStart = cursor;
    let local = 0;
    for (const [index, shot] of (scene.shots ?? []).entries()) {
      const start = Math.round((sceneStart + local) * 30);
      const end = Math.round((sceneStart + local + shot.seconds) * 30);
      const section = document.createElement('section');
      section.className = 'shot';
      section.id = `scene-${scene.id}-${index}`;
      const viewport = document.createElement('div');
      viewport.className = 'capture-viewport';
      const camera = document.createElement('div');
      camera.className = 'camera';
      const image = document.createElement('img');
      image.src = shot.source;
      image.alt = '';
      camera.append(image);
      viewport.append(camera);
      const caption = document.createElement('div');
      caption.className = 'provenance';
      caption.style.top = `${855 + (index % 2) * 10}px`;
      caption.textContent = shot.caption ?? (scene.origin === 'prod' ? 'Captura real · produção\nDados fictícios para demonstração' : 'Captura real · homologação');
      section.append(viewport, caption);
      document.querySelector('#main').append(section);
      const scale = shot.scale ?? 3.3;
      const cy = shot.cy;
      const heroY = 445;
      const pose = (frame, cx, cy, zoom, ease = 'cruise') => [frame, { x: 960 - cx * zoom, y: heroY - cy * zoom, scale: zoom }, ease];
      M.camera(camera, [
        pose(start, shot.cx - 7, cy + 2, scale * 1.025),
        pose(start + 10, shot.cx, cy, scale, 'softLand'),
        pose(end - 6, shot.cx + (shot.panX ?? 9), cy + (shot.panY ?? 1), scale * 1.018),
        pose(end, shot.cx + (shot.panX ?? 9) + 3, cy + (shot.panY ?? 1), scale * 1.026, 'accelExit'),
      ], { origin: '0% 0%' });
      M.kf(caption, 'x', [[start, index % 2 ? 7 : -7], [end, index % 2 ? -7 : 7]]);
      M.show(section, start, end);
      M.mark(start, 'cut', `${scene.title}: ${shot.subject}`);
      local += shot.seconds;
    }
    if (scene.video) {
      if (local >= scene.duration) throw new Error(`Sem intervalo para o vídeo da cena ${scene.id}.`);
      const videoStart = sceneStart + local;
      const section = document.createElement('section');
      section.id = `scene-${scene.id}`;
      section.className = 'shot';
      const video = document.createElement('video');
      video.src = scene.video;
      video.muted = true;
      video.preload = 'auto';
      video.playsInline = true;
      video.dataset.start = videoStart;
      video.style.cssText = 'width:1920px;height:1080px';
      section.append(video);
      document.querySelector('#main').append(section);
      M.show(section, videoStart * 30, (sceneStart + scene.duration) * 30);
      for (const t of [0, 5.7, 7.2]) M.mark(Math.round((videoStart + t) * 30), 'cut', scene.title);
      local = scene.duration;
    }
    if (Math.abs(local - scene.duration) > 0.001) throw new Error(`Duração divergente na cena ${scene.id}.`);
    cursor += scene.duration;
  }
  window.__filmPlan = scenes;
  window.__ready = Motion.loaded().then(() => {
    window.__seekcheck = Motion.selfTest(M, { samples: 24 });
    window.__seek(0);
  });
}
