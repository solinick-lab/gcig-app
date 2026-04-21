import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';

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

export default function Landing() {
  const { user } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) navigate('/dashboard', { replace: true });
  }, [user, navigate]);

  return (
    <div className="min-h-screen bg-white font-sans text-navy antialiased">
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
        <Link to="/" className="flex items-center gap-2 md:gap-3 min-w-0">
          <img
            src="/grace-logo.png"
            alt="Grace Church School"
            className="h-8 w-auto shrink-0 md:h-10"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
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
          className="shrink-0 inline-flex items-center gap-2 border border-navy px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-navy transition hover:bg-navy hover:text-white md:px-5 md:py-2 md:text-xs md:tracking-[0.2em]"
        >
          <span className="hidden sm:inline">Member Login</span>
          <span className="sm:hidden">Sign In</span>
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative border-b border-navy-50 overflow-hidden">
      {/* Parallax background — disabled on mobile (iOS fixed-bg bug) */}
      <style>{`
        .hero-bg {
          background-image: url('https://images.unsplash.com/photo-1527305265013-ddd1054521d6?w=1920&q=80&fm=jpg&crop=entropy&cs=srgb');
          background-size: cover;
          background-position: center;
          background-attachment: fixed;
        }
        @media (max-width: 767px) {
          .hero-bg { background-attachment: scroll; }
        }
      `}</style>
      <div className="hero-bg absolute inset-0" aria-hidden="true" />
      <div className="absolute inset-0 bg-white/[0.88]" aria-hidden="true" />

      <div className="relative">
        <Reveal>
          <div className="mx-auto max-w-5xl px-4 py-16 md:px-10 md:py-36">
            <div className="mb-6 h-px w-12 bg-gold md:mb-8 md:w-16" />
            <h1 className="font-serif text-3xl font-semibold leading-[1.15] tracking-tight text-navy md:text-6xl">
              The Griffin Fund was founded on the premise that disciplined
              investing is best learned by doing — with real capital, rigorous
              research, and accountability to the school community.
            </h1>
            <div className="mt-8 text-[10px] font-semibold uppercase tracking-[0.25em] text-navy-400 md:mt-10 md:text-[11px] md:tracking-[0.3em]">
              Grace Church School · Est. 2021
            </div>
          </div>
        </Reveal>
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
              <div className="mt-2 h-px w-10 bg-navy" />
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
            <div className="mt-2 h-px w-10 bg-navy" />
            <h2 className="mt-5 font-serif text-2xl font-semibold leading-tight text-navy md:mt-6 md:text-4xl">
              Three principles guide everything the fund does.
            </h2>
          </div>
        </Reveal>
        <div className="grid gap-10 md:grid-cols-3 md:gap-10">
          {pillars.map((p, i) => (
            <Reveal key={p.heading} delay={i * 100}>
              <div>
                <div className="font-serif text-4xl font-light text-gold md:text-5xl">
                  {String(i + 1).padStart(2, '0')}
                </div>
                <h3 className="mt-3 font-serif text-xl font-semibold text-navy md:mt-4 md:text-2xl">
                  {p.heading}
                </h3>
                <p className="mt-3 text-[14px] leading-relaxed text-navy-500 md:text-[15px]">
                  {p.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function Leadership() {
  const groups = [
    {
      title: 'Executive Leadership',
      // Ordered by rank (President > CIO); alphabetical by last name inside
      // each rank.
      members: [
        { name: 'Grey Griscom', role: 'President' },
        { name: 'Sander Olinick', role: 'President' },
        { name: 'Thomas Seirer', role: 'President' },
        { name: 'Felix Westergaard', role: 'President' },
        { name: 'Eric Winter', role: 'Chief Investment Officer' },
      ],
    },
    {
      title: 'Portfolio Managers',
      // Ordered by rank (Senior PM > PM); alphabetical by last name inside
      // each rank.
      members: [
        { name: 'Cole H. Fader', role: 'Senior Portfolio Manager · Technology' },
        { name: 'Carter Bayerd', role: 'Portfolio Manager · Industrials' },
        { name: 'Harry de Mendonca', role: 'Portfolio Manager · ETF' },
        { name: 'Eli Friedman', role: 'Portfolio Manager · Consumers' },
        { name: 'Elliot Meyers-Kane', role: 'Portfolio Manager · Energy' },
      ],
    },
  ];

  return (
    <section className="border-b border-navy-50">
      <div className="mx-auto max-w-6xl px-4 py-14 md:px-10 md:py-28">
        <Reveal>
          <div className="mb-10 max-w-2xl md:mb-16">
            <div className="text-[10px] font-semibold uppercase tracking-[0.25em] text-gold-700 md:text-[11px] md:tracking-[0.3em]">
              Leadership
            </div>
            <div className="mt-2 h-px w-10 bg-navy" />
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
                <div className="space-y-3">
                  {group.members.map((m, mi) => (
                    <Reveal key={m.name} delay={gi * 100 + (mi + 1) * 100}>
                      <div>
                        <div className="font-serif text-lg font-semibold text-navy">
                          {m.name}
                        </div>
                        <div className="text-[10px] uppercase tracking-[0.15em] text-navy-400 md:text-[11px] md:tracking-[0.2em]">
                          {m.role}
                        </div>
                      </div>
                    </Reveal>
                  ))}
                </div>
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
    { value: '2021', label: 'Founded' },
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
                  {s.value}
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
