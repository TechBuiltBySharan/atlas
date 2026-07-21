(() => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const revealTargets = document.querySelectorAll(
    ".section h2, .section .eyebrow, .section-sub, .lead, .pillars, .compare, .cap-grid, .provider-split, .terminal, .steps, .roadmap-track, .coming-chips, .install",
  );

  revealTargets.forEach((el) => el.classList.add("reveal"));

  if (reduce) {
    revealTargets.forEach((el) => el.classList.add("visible"));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
  );

  revealTargets.forEach((el) => io.observe(el));

  // Soft parallax on topo orb
  const orb = document.querySelector(".hero-orb");
  const topo = document.querySelector(".topo-lines");
  if (orb && topo) {
    window.addEventListener(
      "pointermove",
      (e) => {
        const x = (e.clientX / window.innerWidth - 0.5) * 12;
        const y = (e.clientY / window.innerHeight - 0.5) * 10;
        orb.style.transform = `translate(${x}px, ${y}px)`;
        topo.style.transform = `translate(${x * -0.35}px, ${y * -0.25}px)`;
      },
      { passive: true },
    );
  }
})();
