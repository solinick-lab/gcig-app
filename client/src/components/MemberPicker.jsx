import { useEffect, useRef, useState } from 'react';
import { X, UserPlus } from 'lucide-react';

/**
 * Multi-select member picker with autocomplete.
 * Props:
 *   users     – full list of members to search (from /users endpoint)
 *   value     – array of selected user ids
 *   onChange  – (nextIds) => void
 */
export default function MemberPicker({ users, value, onChange }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  const selected = users.filter((u) => value.includes(u.id));
  const matches = query.trim()
    ? users.filter(
        (u) =>
          !value.includes(u.id) &&
          u.name.toLowerCase().includes(query.trim().toLowerCase())
      )
    : users.filter((u) => !value.includes(u.id));

  useEffect(() => {
    function handleClick(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function addUser(user) {
    onChange([...value, user.id]);
    setQuery('');
  }

  function removeUser(id) {
    onChange(value.filter((x) => x !== id));
  }

  return (
    <div className="relative" ref={boxRef}>
      <div className="flex min-h-[42px] flex-wrap items-center gap-1 rounded-lg border border-navy-100 px-2 py-1.5">
        {selected.map((u) => (
          <span
            key={u.id}
            className="inline-flex items-center gap-1 rounded-full bg-navy text-white px-2 py-0.5 text-xs font-semibold"
          >
            {u.name}
            <button
              type="button"
              onClick={() => removeUser(u.id)}
              className="rounded-full hover:bg-navy-500"
              aria-label="Remove"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          placeholder={selected.length === 0 ? 'Search members…' : ''}
          className="flex-1 min-w-[120px] bg-transparent px-1 text-sm focus:outline-none"
        />
      </div>

      {open && matches.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-navy-100 bg-white shadow-lg">
          {matches.slice(0, 10).map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => addUser(u)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-navy-50"
              >
                <UserPlus className="h-4 w-4 text-gold" />
                <span className="font-medium text-navy">{u.name}</span>
                <span className="ml-auto text-xs text-navy-400">{u.role}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
