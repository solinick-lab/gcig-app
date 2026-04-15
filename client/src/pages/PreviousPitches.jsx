import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Document, Page, pdfjs } from 'react-pdf';
import { ChevronLeft, ChevronRight, Search, FileText } from 'lucide-react';
import api from '../api/client.js';
import PageHeader from '../components/PageHeader.jsx';
import Card from '../components/Card.jsx';
import Modal from '../components/Modal.jsx';
import Button from '../components/Button.jsx';

// Worker from CDN — matches react-pdf's bundled pdfjs version
pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

export default function PreviousPitches() {
  const [pitches, setPitches] = useState([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);

  useEffect(() => {
    api.get('/pitches').then((r) => setPitches(r.data));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = pitches.filter((p) => p.slideshowUrl);
    if (!q) return list;
    return list.filter(
      (p) =>
        p.ticker.toLowerCase().includes(q) ||
        p.pitcherName.toLowerCase().includes(q)
    );
  }, [pitches, query]);

  function openPitch(p) {
    setSelected(p);
    setPageNumber(1);
    setNumPages(0);
  }

  const isPdf = selected?.slideshowUrl?.toLowerCase().endsWith('.pdf');

  return (
    <>
      <PageHeader
        title="Pitch Archive"
        subtitle="Previously delivered stock pitches and their slideshows."
      />

      <Card>
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-navy-100 px-3 py-2">
          <Search className="h-4 w-4 text-navy-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by ticker or pitcher name…"
            className="flex-1 bg-transparent text-sm focus:outline-none"
          />
        </div>

        {filtered.length === 0 ? (
          <div className="py-12 text-center text-navy-400">
            No pitch slideshows uploaded yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((p) => (
              <button
                key={p.id}
                onClick={() => openPitch(p)}
                className="group flex flex-col overflow-hidden rounded-lg border border-navy-100 bg-white text-left transition hover:border-gold hover:shadow-card"
              >
                <div className="flex h-36 items-center justify-center bg-navy">
                  <FileText className="h-12 w-12 text-gold" />
                </div>
                <div className="p-4">
                  <div className="text-sm font-bold text-navy">{p.ticker}</div>
                  <div className="mt-1 text-sm text-navy-400">{p.pitcherName}</div>
                  <div className="mt-2 text-xs text-navy-400">
                    {format(new Date(p.date), 'MMM d, yyyy')}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.ticker} — ${selected.pitcherName}` : ''}
        size="full"
      >
        {selected && (
          <div>
            {isPdf ? (
              <>
                <div className="flex items-center justify-center">
                  <Document
                    file={selected.slideshowUrl}
                    onLoadSuccess={({ numPages }) => setNumPages(numPages)}
                    loading={<div className="text-navy-400">Loading slideshow…</div>}
                    error={<div className="text-red-600">Failed to load PDF.</div>}
                  >
                    <Page
                      pageNumber={pageNumber}
                      width={Math.min(900, window.innerWidth - 100)}
                    />
                  </Document>
                </div>
                {numPages > 0 && (
                  <div className="mt-4 flex items-center justify-center gap-4">
                    <Button
                      variant="outline"
                      onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                      disabled={pageNumber <= 1}
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Prev
                    </Button>
                    <span className="text-sm text-navy">
                      Page {pageNumber} of {numPages}
                    </span>
                    <Button
                      variant="outline"
                      onClick={() => setPageNumber((p) => Math.min(numPages, p + 1))}
                      disabled={pageNumber >= numPages}
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-lg border border-navy-100 bg-navy-50 p-8 text-center">
                <p className="text-sm text-navy">
                  PowerPoint files are not previewable in-browser.
                </p>
                <a
                  href={selected.slideshowUrl}
                  className="mt-4 inline-block rounded-lg bg-navy px-4 py-2 text-sm font-semibold text-white hover:bg-navy-700"
                >
                  Download {selected.slideshowUrl.split('.').pop().toUpperCase()}
                </a>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
