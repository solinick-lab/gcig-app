const ROLE_LABELS = {
  President: 'President',
  CIO: 'CIO',
  ChiefOfCommunication: 'Chief of Communication',
  SeniorPortfolioManager: 'Sr. Portfolio Manager',
  PortfolioManager: 'Portfolio Manager',
  SeniorAnalyst: 'Senior Analyst',
  Analyst: 'Analyst',
  JuniorAnalyst: 'Junior Analyst',
  AdvisoryBoardMember: 'Advisory Board Member',
  FacultyAdvisory: 'Faculty Advisor',
  FormerPresident: 'Former President',
};

const VARIANTS = {
  President: 'bg-navy text-gold border-navy',
  CIO: 'bg-gold text-navy border-gold',
  ChiefOfCommunication: 'bg-sky-50 text-sky-800 border-sky-200',
  SeniorPortfolioManager: 'bg-gold-300 text-navy border-gold-300',
  PortfolioManager: 'bg-navy-50 text-navy border-navy-100',
  SeniorAnalyst: 'bg-white text-navy border-navy-100',
  Analyst: 'bg-white text-navy-500 border-navy-100',
  JuniorAnalyst: 'bg-white text-navy-500 border-navy-100',
  AdvisoryBoardMember: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  FacultyAdvisory: 'bg-purple-50 text-purple-800 border-purple-200',
  // Echoes the presidential navy/gold, but lighter — reads as an honorary
  // title rather than active office.
  FormerPresident: 'bg-navy-50 text-navy border-gold-300',
};

export default function RoleBadge({ role, className = '' }) {
  const label = ROLE_LABELS[role] || role;
  const variant = VARIANTS[role] || 'bg-white text-navy border-navy-100';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${variant} ${className}`}
    >
      {label}
    </span>
  );
}

export { ROLE_LABELS };
