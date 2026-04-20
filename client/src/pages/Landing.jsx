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
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5 md:px-10 md:py-7">
        <Link to="/" className="flex items-center gap-3">
          <img
            src="/grace-logo.png"
            alt="Grace Church School"
            className="h-10 w-auto"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
          <div className="leading-tight">
            <div className="font-serif text-lg font-semibold tracking-tight text-navy">
              The Griffin Fund
            </div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-navy-400">
              Grace Church School
            </div>
          </div>
        </Link>
        <Link
          to="/login"
          className="inline-flex items-center gap-2 border border-navy px-5 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-navy transition hover:bg-navy hover:text-white"
        >
          Member Login
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
          <div className="mx-auto max-w-5xl px-6 py-24 md:px-10 md:py-36">
            <div className="mb-8 h-px w-16 bg-gold" />
            <h1 className="font-serif text-4xl font-semibold leading-[1.15] tracking-tight text-navy md:text-6xl">
              The Griffin Fund was founded on the premise that disciplined
              investing is best learned by doing — with real capital, rigorous
              research, and accountability to the school community.
            </h1>
            <div className="mt-10 text-[11px] font-semibold uppercase tracking-[0.3em] text-navy-400">
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
      <div className="mx-auto max-w-5xl px-6 py-20 md:px-10 md:py-28">
        <Reveal>
          <div className="grid gap-12 md:grid-cols-[240px_1fr] md:gap-20">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-gold-700">
                The Fund
              </div>
              <div className="mt-2 h-px w-10 bg-navy" />
            </div>
            <div className="font-serif text-lg leading-relaxed text-navy md:text-xl">
              <p>
                The Griffin Fund is the Grace Church School Investment Group — a
                student-run investment fund established in 2021 to manage a
                real, multi-year capital pool on behalf of the school community.
              </p>
              <p className="mt-6">
                Day-to-day decisions are made by students elected and promoted
                through the fund's own ranks. Oversight comes from the school
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
      <div className="mx-auto max-w-6xl px-6 py-20 md:px-10 md:py-28">
        <Reveal>
          <div className="mb-12 max-w-2xl md:mb-20">
            <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-gold-700">
              How we invest
            </div>
            <div className="mt-2 h-px w-10 bg-navy" />
            <h2 className="mt-6 font-serif text-3xl font-semibold leading-tight text-navy md:text-4xl">
              Three principles guide everything the fund does.
            </h2>
          </div>
        </Reveal>
        <div className="grid gap-12 md:grid-cols-3 md:gap-10">
          {pillars.map((p, i) => (
            <Reveal key={p.heading} delay={i * 100}>
              <div>
                <div className="font-serif text-5xl font-light text-gold">
                  {String(i + 1).padStart(2, '0')}
                </div>
                <h3 className="mt-4 font-serif text-2xl font-semibold text-navy">
                  {p.heading}
                </h3>
                <p className="mt-3 text-[15px] leading-relaxed text-navy-500">
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
      members: [
        { name: 'Sander Olinick', role: 'President' },
        { name: 'Thomas Seirer', role: 'President' },
        { name: 'Felix Westergaard', role: 'President' },
        { name: 'Grey Griscom', role: 'President' },
        { name: 'Eric Winter', role: 'Chief Investment Officer' },
      ],
    },
    {
      title: 'Portfolio Managers',
      members: [
        { name: 'Cole H. Fader', role: 'Senior Portfolio Manager · Technology' },
        { name: 'Elliot Meyers-Kane', role: 'Portfolio Manager · Energy' },
        { name: 'Harry de Mendonca', role: 'Portfolio Manager · ETF' },
        { name: 'Eli Friedman', role: 'Portfolio Manager · Consumers' },
        { name: 'Carter Bayerd', role: 'Portfolio Manager · Industrials' },
      ],
    },
  ];

  return (
    <section className="border-b border-navy-50">
      <div className="mx-auto max-w-6xl px-6 py-20 md:px-10 md:py-28">
        <Reveal>
          <div className="mb-12 max-w-2xl md:mb-16">
            <div className="text-[11px] font-semibold uppercase tracking-[0.3em] text-gold-700">
              Leadership
            </div>
            <div className="mt-2 h-px w-10 bg-navy" />
            <h2 className="mt-6 font-serif text-3xl font-semibold leading-tight text-navy md:text-4xl">
              Elected from within the ranks.
            </h2>
            <p className="mt-4 font-serif text-lg leading-relaxed text-navy-500">
              Day-to-day leadership of the fund is elected by the membership
              and rotates annually.
            </p>
          </div>
        </Reveal>

        <div className="grid gap-12 md:grid-cols-2 md:gap-16">
          {groups.map((group, gi) => (
            <Reveal key={group.title} delay={gi * 100}>
              <div>
                <div className="mb-6 text-[11px] font-semibold uppercase tracking-[0.25em] text-navy-400">
                  {group.title}
                </div>
                <div className="space-y-3">
                  {group.members.map((m, mi) => (
                    <Reveal key={m.name} delay={gi * 100 + (mi + 1) * 100}>
                      <div>
                        <div className="font-serif text-lg font-semibold text-navy">
                          {m.name}
                        </div>
                        <div className="text-[11px] uppercase tracking-[0.2em] text-navy-400">
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
          <p className="mt-12 text-sm italic text-navy-400">
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
      <div className="mx-auto max-w-6xl px-6 py-16 md:px-10 md:py-20">
        <div className="grid grid-cols-2 gap-y-10 md:grid-cols-4">
          {stats.map((s, i) => (
            <Reveal key={s.label} delay={i * 100}>
              <div className="border-l border-navy-100 px-6 first:border-l-0 md:first:border-l md:first:pl-6">
                <div className="font-serif text-2xl font-semibold leading-tight text-navy md:text-3xl">
                  {s.value}
                </div>
                <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-navy-400">
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
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 md:flex-row md:items-center md:justify-between md:px-10">
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
