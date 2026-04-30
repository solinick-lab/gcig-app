import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import api from '../api/client.js';

// Public landing for The Griffin Fund. Modeled on Select Equity Group's
// website: text-forward, institutional, restrained palette (white page, navy
// type, gold rules), serif display type. No recruitment — the page exists so
// parents, alumni, and the school community can read about the fund, and so
// members have a front door to the login.
//
// Authed users are silently redirected to /dashboard so the app opens where
// they left off.

// ---------------------------------------------------------------------------
// Reveal — Linear-style scroll-into-view animation wrapper.
// Uses Intersection Observer. Fires once (no re-animation on scroll-up).
// Respects prefers-reduced-motion.
// ---------------------------------------------------------------------------
function Reveal({ children, delay = 0, className = '' }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'none' : 'translateY(20px)',
        transition: `opacity 700ms cubic-bezier(0.16,1,0.3,1) ${delay}ms, transform 700ms cubic-bezier(0.16,1,0.3,1) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

const EASE_OUT = 'cubic-bezier(0.16,1,0.3,1)';

// Hook: returns true once the element scrolls into view, then stays true.
function useInView(threshold = 0.15) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setSeen(true);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setSeen(true);
          obs.disconnect();
        }
      },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return [ref, seen];
}

// Word-reveal — splits children-as-string into spans that rise individually.
function WordReveal({ text, base = 0, step = 80, duration = 900, className = '' }) {
  const [ref, seen] = useInView(0.2);
  const words = text.split(/(\s+)/);
  return (
    <span ref={ref} className={className} style={{ display: 'inline' }}>
      {words.map((w, i) => {
        if (/^\s+$/.test(w)) return <span key={i}>{w}</span>;
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              opacity: seen ? 1 : 0,
              transform: seen ? 'translateY(0)' : 'translateY(40%)',
              transition: `opacity ${duration}ms ${EASE_OUT} ${base + i * step}ms, transform ${duration}ms ${EASE_OUT} ${base + i * step}ms`,
              willChange: 'transform, opacity',
            }}
          >
            {w}
          </span>
        );
      })}
    </span>
  );
}

// Gold rule that draws across left → right when in view. Drop-in
// replacement for `<div className="h-px w-12 bg-gold" />` patterns.
function RuleSweep({ width = 'w-12', color = 'bg-gold', delay = 0, className = '' }) {
  const [ref, seen] = useInView(0.3);
  return (
    <div ref={ref} className={`relative h-px ${width} ${className}`}>
      <div
        className={`absolute inset-0 ${color}`}
        style={{
          transformOrigin: 'left',
          transform: seen ? 'scaleX(1)' : 'scaleX(0)',
          transition: `transform 1100ms cubic-bezier(0.77,0,0.175,1) ${delay}ms`,
        }}
      />
    </div>
  );
}

// CountUp — animates an integer from 0 → target once it's visible. The
// final formatted string is shown to assistive tech immediately so the
// counter never reads as "0" to a screen reader.
function CountUp({ target, duration = 1400, className = '' }) {
  const [ref, seen] = useInView(0.4);
  const [n, setN] = useState(0);
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    if (!seen || reduced) {
      setN(target);
      return;
    }
    const start = performance.now();
    let raf;
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setN(Math.round(eased * target));
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, target, duration, reduced]);
  return (
    <span ref={ref} className={className} aria-label={String(target)}>
      <span aria-hidden="true">{n}</span>
    </span>
  );
}

// Top-of-viewport scroll progress hairline.
function ScrollProgress() {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    let ticking = false;
    const update = () => {
      const h = document.documentElement;
      const scrolled = h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight);
      setPct(scrolled * 100);
      ticking = false;
    };
    const onScroll = () => {
      if (!ticking) {
        requestAnimationFrame(update);
        ticking = true;
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: 200,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${pct}%`,
          background: '#C9A84C',
          transition: 'width 80ms linear',
        }}
      />
    </div>
  );
}

// Mouse-spring parallax for the hero. Subtly translates a target ref
// based on cursor position inside the section, with a critically-damped
// lerp so it trails the cursor instead of snapping.
function useHeroParallax(scopeRef, targetRef, range = 12) {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const scope = scopeRef.current;
    const target = targetRef.current;
    if (!scope || !target) return;

    let tx = 0, ty = 0, cx = 0, cy = 0;
    let raf = null, inside = false;

    function onMove(e) {
      const r = scope.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      tx = nx * range;
      ty = ny * (range * 0.6);
      inside = true;
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function onLeave() {
      tx = 0;
      ty = 0;
      inside = false;
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function tick() {
      cx += (tx - cx) * 0.06;
      cy += (ty - cy) * 0.06;
      target.style.transform = `translate3d(${cx.toFixed(2)}px, ${cy.toFixed(2)}px, 0) scale(1.04)`;
      if (Math.abs(tx - cx) > 0.05 || Math.abs(ty - cy) > 0.05 || inside) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = null;
      }
    }
    scope.addEventListener('pointermove', onMove, { passive: true });
    scope.addEventListener('pointerleave', onLeave);
    return () => {
      scope.removeEventListener('pointermove', onMove);
      scope.removeEventListener('pointerleave', onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scopeRef, targetRef, range]);
}

export default function Landing() {
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) navigate('/dashboard', { replace: true });
  }, [user, navigate]);

  return (
    <div className="min-h-screen bg-white font-sans text-navy antialiased">
      <ScrollProgress />
      <Header />
      <Hero />
      <Premise />
      <Pillars />
      <Leadership />
      <Numbers />
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-navy-50">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-4 md:px-10 md:py-7">
        <Link to="/" className="group flex items-center gap-2 md:gap-3 min-w-0">
          <img
            src="/grace-logo.png"
            alt="Grace Church School"
            className="h-8 w-auto shrink-0 md:h-10"
            style={{ transition: `transform 500ms ${EASE_OUT}` }}
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
          <style>{`.group:hover img[alt="Grace Church School"] { transform: rotate(-8deg); }`}</style>
          <div className="leading-tight min-w-0">
            <div className="font-serif text-base font-semibold tracking-tight text-navy md:text-lg">
              The Griffin Fund
            </div>
            {/* Subtitle hidden on phones to keep the header on one line with
                the Member Login button. */}
            <div className="hidden text-[10px] uppercase tracking-[0.25em] text-navy-400 sm:block">
              Grace Church School
            </div>
          </div>
        </Link>
        <Link
          to="/login"
          className="member-login shrink-0 inline-flex items-center gap-2 border border-navy px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-navy md:px-5 md:py-2 md:text-xs md:tracking-[0.2em]"
          style={{ transition: `background-color 220ms ${EASE_OUT}, color 220ms ${EASE_OUT}, transform 160ms ${EASE_OUT}` }}
        >
          <span className="hidden sm:inline">Member Login</span>
          <span className="sm:hidden">Sign In</span>
          <span className="member-login-arrow inline-block" aria-hidden="true">→</span>
        </Link>
        <style>{`
          .member-login:hover { background: #1B2A4A; color: #fff; }
          .member-login:active { transform: scale(0.97); }
          .member-login-arrow { transition: transform 220ms ${EASE_OUT}; transform: translateX(0); }
          .member-login:hover .member-login-arrow { transform: translateX(4px); }
        `}</style>
      </div>
    </header>
  );
}

function Hero() {
  const sectionRef = useRef(null);
  const bgRef = useRef(null);
  useHeroParallax(sectionRef, bgRef, 18);

  return (
    <section ref={sectionRef} className="relative border-b border-navy-50 overflow-hidden">
      {/* Parallax background — disabled on mobile (iOS fixed-bg bug).
          The mouse-spring also translates this layer, so we keep the cover
          slightly larger via scale(1.04) to hide the edges. */}
      <style>{`
        .hero-bg {
          background-image: url('/hero-skyline.jpg');
          background-size: cover;
          background-position: center;
          background-attachment: fixed;
          transform: scale(1.04);
          will-change: transform;
        }
        @media (max-width: 767px) {
          .hero-bg { background-attachment: scroll; }
        }
        @keyframes heroEyebrowFade {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .hero-eyebrow { animation: heroEyebrowFade 800ms ${EASE_OUT} both; animation-delay: 1400ms; }
      `}</style>
      <div ref={bgRef} className="hero-bg absolute inset-0" aria-hidden="true" />
      <div className="absolute inset-0 bg-white/[0.88]" aria-hidden="true" />

      <div className="relative">
        <div className="mx-auto max-w-5xl px-4 py-16 md:px-10 md:py-36">
          <RuleSweep
            width="w-12 md:w-16"
            color="bg-gold"
            className="mb-6 md:mb-8"
          />
          <h1 className="font-serif text-3xl font-semibold leading-[1.15] tracking-tight text-navy md:text-6xl">
            <WordReveal
              text="The Griffin Fund was founded on the premise that disciplined investing is best learned by doing — with real capital, rigorous research, and accountability to the school community."
              base={300}
              step={45}
              duration={1000}
            />
          </h1>
          <div className="hero-eyebrow mt-8 text-[10px] font-semibold uppercase tracking-[0.25em] text-navy-400 md:mt-10 md:text-[11px] md:tracking-[0.3em]">
            Grace Church School · Est. 2021
          </div>
        </div>
      </div>
    </section>
  );
}

function Premise() {
  return (
    <section className="border-b border-navy-50">
      <div className="mx-auto max-w-5xl px-4 py-14 md:px-10 md:py-28">
        <Reveal>
          <div className="grid gap-8 md:grid-cols-[240px_1fr] md:gap-20">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700 md:text-[11px] md:tracking-[0.3em]">
                The Fund
              </div>
              <RuleSweep width="w-10" color="bg-navy" className="mt-2" delay={150} />
            </div>
            <div className="font-serif text-[17px] leading-relaxed text-navy md:text-xl">
              <p>
                The Griffin Fund is the Grace Church School Investment Group — a
                student-run investment fund established in 2021 to manage a
                real, multi-year capital pool on behalf of the school community.
              </p>
              <p className="mt-6">
                Day-to-day decisions are made by students appointed and
                promoted through the fund's own ranks. Oversight comes from the
                school
                and from an advisory board of parent volunteers who work in
                finance. The fund invests only in publicly traded US equities,
                ETFs, and cash equivalents — no derivatives, no commodities, no
                short-term speculation. Every position is researched, pitched,
                and voted on before capital is committed.
              </p>
              <p className="mt-6">
                The goal is not performance for its own sake. It is to give
                students a genuine, high-stakes classroom for learning how
                markets work, how capital is allocated, and how professional
                investors think about risk.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Pillars() {
  const pillars = [
    {
      heading: 'Research',
      body: 'Every pitch begins with written analysis — thesis, valuation, risks, and catalysts. Ideas are workshopped inside sector pods before they reach the full body, and only positions that survive that scrutiny come to a vote.',
    },
    {
      heading: 'Discipline',
      body: 'The fund operates inside a written Investment Policy Statement. Positions are held for the long term, capped in size, and reviewed on a standing schedule. When the market moves against us, we revisit the thesis — we don\'t panic out of it.',
    },
    {
      heading: 'Stewardship',
      body: 'This is real capital, entrusted to students by Grace Church School. Every trade is logged, every decision is recorded, and the fund is accountable to faculty and to the advisory board on a standing quarterly basis.',
    },
  ];
  return (
    <section className="border-b border-navy-50 bg-[#FAFAF7]">
      <div className="mx-auto max-w-6xl px-4 py-14 md:px-10 md:py-28">
        <Reveal>
          <div className="mb-10 max-w-2xl md:mb-20">
            <div className="text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700 md:text-[11px] md:tracking-[0.3em]">
              How we invest
            </div>
            <RuleSweep width="w-10" color="bg-navy" className="mt-2" delay={150} />
            <h2 className="mt-5 font-serif text-2xl font-semibold leading-tight text-navy md:mt-6 md:text-4xl">
              Three principles guide everything the fund does.
            </h2>
          </div>
        </Reveal>
        <div className="grid gap-10 md:grid-cols-3 md:gap-10">
          {pillars.map((p, i) => (
            <Pillar key={p.heading} index={i} pillar={p} />
          ))}
        </div>
      </div>
    </section>
  );
}

// Single pillar card. Numeral rises with a slight scale, then heading and
// body fade in after, all gated on the card itself entering view.
function Pillar({ pillar, index }) {
  const [ref, seen] = useInView(0.25);
  const stagger = index * 120;
  const numStyle = {
    display: 'inline-block',
    opacity: seen ? 1 : 0,
    transform: seen ? 'translateY(0) scale(1)' : 'translateY(28px) scale(0.94)',
    transition: `opacity 1100ms ${EASE_OUT} ${stagger}ms, transform 1100ms ${EASE_OUT} ${stagger}ms`,
    willChange: 'transform, opacity',
  };
  const textStyle = (extraDelay) => ({
    opacity: seen ? 1 : 0,
    transform: seen ? 'translateY(0)' : 'translateY(14px)',
    transition: `opacity 800ms ${EASE_OUT} ${stagger + extraDelay}ms, transform 800ms ${EASE_OUT} ${stagger + extraDelay}ms`,
  });
  return (
    <div ref={ref}>
      <div className="font-serif text-4xl font-light text-gold md:text-5xl" style={numStyle}>
        {String(index + 1).padStart(2, '0')}
      </div>
      <h3
        className="mt-3 font-serif text-xl font-semibold text-navy md:mt-4 md:text-2xl"
        style={textStyle(280)}
      >
        {pillar.heading}
      </h3>
      <p
        className="mt-3 text-[14px] leading-relaxed text-navy-500 md:text-[15px]"
        style={textStyle(420)}
      >
        {pillar.body}
      </p>
    </div>
  );
}

function Leadership() {
  const groups = [
    {
      title: 'Executive Leadership',
      // Ordered by rank (President > CIO); alphabetical by last name inside
      // each rank. `photo` is optional — members without one get a serif
      // monogram of their initials tinted by inferred gender.
      members: [
        { name: 'Grey Griscom', role: 'President' },
        { name: 'Sander Olinick', role: 'President', photo: '/leadership/sander-olinick.jpg' },
        { name: 'Thomas Seirer', role: 'President', photo: '/leadership/thomas-seirer.jpg' },
        { name: 'Felix Westergaard', role: 'President', photo: '/leadership/felix-westergaard.jpg' },
        { name: 'Eric Winter', role: 'Chief Investment Officer', photo: '/leadership/eric-winter.jpg' },
      ],
    },
    {
      title: 'Portfolio Managers',
      // Ordered by rank (Senior PM > PM); alphabetical by last name inside
      // each rank.
      members: [
        { name: 'Cole H. Fader', role: 'Senior Portfolio Manager · Technology' },
        { name: 'Carter Bayerd', role: 'Portfolio Manager · Industrials', photo: '/leadership/carter-bayerd.jpg' },
        { name: 'Harry de Mendonca', role: 'Portfolio Manager · ETF' },
        { name: 'Eli Friedman', role: 'Portfolio Manager · Consumers', photo: '/leadership/eli-friedman.jpg' },
        { name: 'Elliot Meyers-Kane', role: 'Portfolio Manager · Energy' },
      ],
    },
  ];

  // Batch-look up inferred gender for every member name — used to tint
  // the monogram fallback. Public endpoint, single request.
  const allNames = useMemo(
    () => groups.flatMap((g) => g.members.map((m) => m.name)),
    // `groups` is defined inline every render but its content is static
    // for this page, so the dependency list is intentionally empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [genderMap, setGenderMap] = useState(() => new Map());
  useEffect(() => {
    let cancelled = false;
    api
      .post('/public/name-gender', { names: allNames })
      .then((res) => {
        if (cancelled) return;
        const m = new Map();
        for (const r of res.data?.results || []) {
          m.set(r.name, r.gender);
        }
        setGenderMap(m);
      })
      .catch(() => {
        /* fall back to the default (neutral) tint — harmless if this fails. */
      });
    return () => {
      cancelled = true;
    };
  }, [allNames]);

  return (
    <section className="border-b border-navy-50">
      <style>{`
        .member-row:hover { transform: translateX(4px); }
        .member-row:hover .member-avatar { box-shadow: 0 6px 20px -8px rgba(27, 42, 74, 0.35); }
      `}</style>
      <div className="mx-auto max-w-6xl px-4 py-14 md:px-10 md:py-28">
        <Reveal>
          <div className="mb-10 max-w-2xl md:mb-16">
            <div className="text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700 md:text-[11px] md:tracking-[0.3em]">
              Leadership
            </div>
            <RuleSweep width="w-10" color="bg-navy" className="mt-2" delay={150} />
            <h2 className="mt-5 font-serif text-2xl font-semibold leading-tight text-navy md:mt-6 md:text-4xl">
              Led from within the club.
            </h2>
            <p className="mt-3 font-serif text-base leading-relaxed text-navy-500 md:mt-4 md:text-lg">
              Led by founding members, with new leadership appointed as the
              fund grows.
            </p>
          </div>
        </Reveal>

        <div className="grid gap-10 md:grid-cols-2 md:gap-16">
          {groups.map((group, gi) => (
            <Reveal key={group.title} delay={gi * 100}>
              <div>
                <div className="mb-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-navy-400 md:mb-6 md:text-[11px] md:tracking-[0.25em]">
                  {group.title}
                </div>
                <ul className="space-y-4">
                  {group.members.map((m, mi) => (
                    <Reveal key={m.name} delay={gi * 100 + (mi + 1) * 100}>
                      <li
                        className="member-row flex items-center gap-4"
                        style={{ transition: `transform 280ms ${EASE_OUT}` }}
                      >
                        <MemberAvatar member={m} gender={genderMap.get(m.name)} />
                        <div className="min-w-0">
                          <div className="font-serif text-lg font-semibold text-navy">
                            {m.name}
                          </div>
                          <div className="text-[10px] uppercase tracking-[0.15em] text-navy-400 md:text-[11px] md:tracking-[0.2em]">
                            {m.role}
                          </div>
                        </div>
                      </li>
                    </Reveal>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delay={700}>
          <p className="mt-10 text-sm italic text-navy-400 md:mt-12">
            Faculty advisor: Nicholas Kurian.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

function Numbers() {
  const stats = [
    { value: '2021', label: 'Founded', countUp: 2021 },
    { value: 'Six figures', label: 'Capital under management' },
    { value: 'US equities, ETFs', label: 'Investment universe' },
    { value: 'Quarterly', label: 'Advisory board review' },
  ];
  return (
    <section className="border-b border-navy-50">
      <div className="mx-auto max-w-6xl px-4 py-14 md:px-10 md:py-20">
        <div className="grid grid-cols-2 gap-x-2 gap-y-10 md:grid-cols-4 md:gap-x-0">
          {stats.map((s, i) => (
            <Reveal key={s.label} delay={i * 100}>
              {/*
                Left-side divider behavior:
                  Mobile (2 cols): show a left border only on the RIGHT
                  column items (1 and 3) — odd:border-l-0 hides it on the
                  left-column items (0 and 2).
                  Desktop (4 cols): show on every item except the first.
              */}
              <div className="border-l border-navy-100 px-4 odd:border-l-0 md:px-6 md:odd:border-l md:first:border-l-0">
                <div className="font-serif text-xl font-semibold leading-tight text-navy md:text-3xl">
                  {s.countUp ? <CountUp target={s.countUp} duration={1500} /> : s.value}
                </div>
                <div className="mt-2 text-[9px] font-semibold uppercase tracking-[0.2em] text-navy-400 md:text-[10px] md:tracking-[0.25em]">
                  {s.label}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="bg-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-8 md:flex-row md:items-center md:justify-between md:gap-6 md:px-10 md:py-10">
        <div className="flex items-center gap-3">
          <img
            src="/grace-logo.png"
            alt=""
            className="h-8 w-auto opacity-80"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
          <div className="text-xs leading-tight text-navy-400">
            <div className="font-semibold text-navy">The Griffin Fund</div>
            <div>Grace Church School Investment Group</div>
          </div>
        </div>
        <div className="flex items-center gap-6 text-[10px] font-semibold uppercase tracking-[0.25em] text-navy-400">
          <Link to="/login" className="transition hover:text-navy">
            Member Login
          </Link>
          <span>&copy; {new Date().getFullYear()}</span>
        </div>
      </div>
    </footer>
  );
}

// Circular avatar for the Leadership list. Uses a real photo when the
// member object has `photo`, otherwise falls back to a gold-on-navy
// monogram built from the member's initials. Keeps the list visually
// consistent even when only some members have headshots.
// Tint the monogram backdrop + glyph color by inferred gender. Only
// visible on members without a headshot (the photo layer covers the
// backdrop when it loads). Keeps both variants inside the brand
// palette — no pink/blue stereotype, just a cool / warm split.
const AVATAR_TINT = {
  M: { bg: 'bg-navy', fg: 'text-gold' },
  F: { bg: 'bg-gold-200', fg: 'text-navy' },
  U: { bg: 'bg-navy-100', fg: 'text-navy' },
};

function MemberAvatar({ member, gender }) {
  const initials = member.name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const tint = AVATAR_TINT[gender] || AVATAR_TINT.U;

  return (
    <div
      className={`member-avatar relative h-12 w-12 shrink-0 overflow-hidden rounded-full border border-navy-100 ${tint.bg}`}
      style={{ transition: `box-shadow 320ms ${EASE_OUT}` }}
    >
      {member.photo && (
        <img
          src={member.photo}
          alt={member.name}
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      )}
      {/* Monogram sits behind the image; if the image fails or is absent,
          it's visible. Color tint signals inferred gender; if we couldn't
          infer (or haven't fetched yet), the neutral navy-100 variant is
          used so the tile still reads. */}
      <div
        className={`flex h-full w-full items-center justify-center font-serif text-sm font-semibold ${tint.fg}`}
      >
        {initials}
      </div>
    </div>
  );
}
