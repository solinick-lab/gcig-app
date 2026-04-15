import { X } from 'lucide-react';

export default function Modal({ open, onClose, title, children, size = 'md' }) {
  if (!open) return null;
  const sizes = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-6xl',
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy/60 p-4"
      onClick={onClose}
    >
      <div
        className={`w-full ${sizes[size]} max-h-[90vh] overflow-hidden rounded-xl bg-white shadow-xl flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-navy-50 px-5 py-4">
          <h2 className="text-lg font-semibold text-navy">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-navy-400 hover:bg-navy-50 hover:text-navy"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}
