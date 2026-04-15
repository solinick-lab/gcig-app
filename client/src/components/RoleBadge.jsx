const ROLE_LABELS = {
  President: 'President',
  CIO: 'CIO',
  SeniorPortfolioManager: 'Sr. Portfolio Manager',
  PortfolioManager: 'Portfolio Manager',
  SeniorAnalyst: 'Senior Analyst',
  JuniorAnalyst: 'Junior Analyst',
};

const VARIANTS = {
  President: 'bg-navy text-gold border-navy',
  CIO: 'bg-gold text-navy border-gold',
  SeniorPortfolioManager: 'bg-gold-300 text-navy border-gold-300',
  PortfolioManager: 'bg-navy-50 text-navy border-navy-100',
  SeniorAnalyst: 'bg-white text-navy border-navy-100',
  JuniorAnalyst: 'bg-white text-navy-500 border-navy-100',
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
