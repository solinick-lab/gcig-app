const VARIANTS = {
  primary: 'bg-navy text-white hover:bg-navy-700',
  gold: 'bg-gold text-navy hover:bg-gold-600 hover:text-white',
  outline: 'border border-navy-100 bg-white text-navy hover:bg-navy-50',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};

export default function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  children,
  ...props
}) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
