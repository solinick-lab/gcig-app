export default function Card({ children, className = '', title, action }) {
  return (
    <div className={`rounded-xl border border-navy-100 bg-white shadow-card ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between border-b border-navy-50 px-5 py-4">
          {title && <h2 className="text-sm font-semibold text-navy">{title}</h2>}
          {action}
        </div>
      )}
      <div className="p-5">{children}</div>
    </div>
  );
}
