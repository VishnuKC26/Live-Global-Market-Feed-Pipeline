import React, { useState, useMemo, useRef, useEffect } from 'react';
import { 
  Calendar, 
  Search, 
  Pin, 
  Copy, 
  Trash2, 
  Clipboard, 
  AlertCircle, 
  X
} from 'lucide-react';

const getLocalDateString = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export default function Notepad({
  notes = {},
  activeDate,
  setActiveDate,
  onSaveManualNote,
  onPasteFromClipboard,
  onDeleteNote,
  onTogglePinNote,
  onUpdateNote,
  onCopyNoteText,
  showToast
}) {
  // General view state
  const [searchQuery, setSearchQuery] = useState('');

  // Note creator state
  const [isCreatorExpanded, setIsCreatorExpanded] = useState(false);
  const [creatorTitle, setCreatorTitle] = useState('');
  const [creatorText, setCreatorText] = useState('');
  const [creatorPinned, setCreatorPinned] = useState(false);
  const [creatorDate, setCreatorDate] = useState(activeDate || getLocalDateString());

  // Note editing state (modal)
  const [editingNote, setEditingNote] = useState(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [editingText, setEditingText] = useState('');
  const [editingPinned, setEditingPinned] = useState(false);
  const [editingNoteDate, setEditingNoteDate] = useState('');

  const creatorRef = useRef(null);

  // Synchronize creator date when active date changes in the parent
  useEffect(() => {
    if (activeDate) {
      setCreatorDate(activeDate);
    }
  }, [activeDate]);

  // Click outside Note Creator to automatically save and collapse
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (creatorRef.current && !creatorRef.current.contains(e.target)) {
        if (creatorText.trim() || creatorTitle.trim()) {
          handleCreateNoteSubmit();
        } else {
          setIsCreatorExpanded(false);
        }
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [creatorText, creatorTitle, creatorPinned, creatorDate, activeDate]);

  // Compile all notes across all dates into a flat list
  const allNotes = useMemo(() => {
    const list = [];
    Object.keys(notes).forEach(dateStr => {
      const dayNotes = notes[dateStr] || [];
      dayNotes.forEach(note => {
        list.push({
          ...note,
          date: dateStr
        });
      });
    });
    return list;
  }, [notes]);

  // Filter and sort notes
  const filteredNotes = useMemo(() => {
    let result = [...allNotes];

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(note => 
        (note.content && note.content.toLowerCase().includes(query)) ||
        (note.title && note.title.toLowerCase().includes(query))
      );
    }

    // Sort: newest first
    return result.sort((a, b) => {
      const dateTimeA = new Date(`${a.date}T${a.time || '00:00'}:00`).getTime();
      const dateTimeB = new Date(`${b.date}T${b.time || '00:00'}:00`).getTime();
      return dateTimeB - dateTimeA;
    });
  }, [allNotes, searchQuery]);

  // Pinned vs Other notes
  const pinnedNotes = useMemo(() => {
    return filteredNotes.filter(note => note.pinned);
  }, [filteredNotes]);

  const otherNotes = useMemo(() => {
    return filteredNotes.filter(note => !note.pinned);
  }, [filteredNotes]);

  // Save new manual note
  const handleCreateNoteSubmit = (e) => {
    if (e) e.preventDefault();
    if (!creatorText.trim() && !creatorTitle.trim()) {
      setIsCreatorExpanded(false);
      return;
    }

    const targetDate = creatorDate || activeDate || getLocalDateString();
    onSaveManualNote(creatorText.trim(), targetDate, creatorTitle.trim(), '', creatorPinned);

    // Reset state
    setCreatorTitle('');
    setCreatorText('');
    setCreatorPinned(false);
    setIsCreatorExpanded(false);
  };

  // Paste from Clipboard to active creator note
  const handlePasteToCreator = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || text.trim() === '') {
        showToast('Clipboard is empty', 'error');
        return;
      }
      setCreatorText(prev => prev ? `${prev}\n${text.trim()}` : text.trim());
      setIsCreatorExpanded(true);
      showToast('Clipboard content inserted', 'success');
    } catch (err) {
      console.error('Clipboard paste failed:', err);
      showToast('Clipboard access unavailable. Please paste manually.', 'error');
    }
  };

  // Open note edit modal
  const handleOpenEditModal = (note) => {
    setEditingNote(note);
    setEditingTitle(note.title || '');
    setEditingText(note.content || '');
    setEditingPinned(note.pinned || false);
    setEditingNoteDate(note.date || activeDate);
  };

  // Commit changes from edit modal
  const handleSaveEdit = () => {
    if (!editingNote) return;

    const titleChanged = editingTitle !== (editingNote.title || '');
    const textChanged = editingText !== (editingNote.content || '');
    const pinnedChanged = editingPinned !== (editingNote.pinned || false);
    const dateChanged = editingNoteDate !== (editingNote.date || '');

    if (titleChanged || textChanged || pinnedChanged || dateChanged) {
      onUpdateNote(editingNote.id, editingNote.date, {
        title: editingTitle,
        content: editingText,
        pinned: editingPinned,
        date: editingNoteDate
      });
      showToast('Note updated successfully', 'success');
    }

    setEditingNote(null);
  };

  // Card specific button clicks (propagate protection)
  const handleCardTogglePin = (e, note) => {
    e.stopPropagation();
    onTogglePinNote(note.id, note.date);
  };

  const handleCardDelete = (e, note) => {
    e.stopPropagation();
    onDeleteNote(note.id, note.date);
  };

  const handleCardCopy = (e, noteContent) => {
    e.stopPropagation();
    onCopyNoteText(noteContent);
  };

  // Helper function to format readable dates for cards
  const formatCardDate = (dateStr) => {
    if (!dateStr) return '';
    try {
      const dateObj = new Date(dateStr + 'T00:00:00');
      return dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="notepad-container">
      {/* Search Row (Centered alignment matching Take a Note card) */}
      <div className="notepad-search-row" style={{ justifyContent: 'center' }}>
        <div className="notepad-search-wrapper" style={{ maxWidth: '580px' }}>
          <Search size={16} className="notepad-search-icon" />
          <input
            type="text"
            placeholder="Search titles & content..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="notepad-search-input"
          />
        </div>
      </div>

      {/* Note Creator Section (Google Keep layout) */}
      <div className="notepad-creator-wrapper">
        <div 
          ref={creatorRef} 
          className={`notepad-creator ${isCreatorExpanded ? 'expanded' : ''}`}
        >
          {!isCreatorExpanded ? (
            <div 
              className="notepad-creator-collapsed" 
              onClick={() => setIsCreatorExpanded(true)}
            >
              <span className="notepad-creator-collapsed-text">Take a note...</span>
              <div className="notepad-creator-collapsed-actions">
                <button 
                  type="button" 
                  onClick={(e) => { e.stopPropagation(); handlePasteToCreator(); }}
                  className="btn-creator-action"
                  title="Paste from Clipboard"
                >
                  <Clipboard size={16} />
                </button>
              </div>
            </div>
          ) : (
            <div className="notepad-creator-expanded">
              <div className="notepad-creator-header">
                <input
                  type="text"
                  placeholder="Title"
                  value={creatorTitle}
                  onChange={(e) => setCreatorTitle(e.target.value)}
                  className="notepad-creator-title-input"
                />
                <button
                  type="button"
                  onClick={() => setCreatorPinned(prev => !prev)}
                  className={`btn-creator-action ${creatorPinned ? 'btn-card-pin active-pin' : ''}`}
                  title={creatorPinned ? "Unpin Note" : "Pin Note"}
                >
                  <Pin size={16} fill={creatorPinned ? "currentColor" : "none"} />
                </button>
              </div>

              <textarea
                placeholder="Take a note..."
                value={creatorText}
                onChange={(e) => setCreatorText(e.target.value)}
                className="notepad-creator-textarea"
                rows={3}
                autoFocus
              />

              <div className="notepad-creator-date-row">
                <span>Associate with date:</span>
                <input
                  type="date"
                  value={creatorDate}
                  onChange={(e) => setCreatorDate(e.target.value)}
                  className="notepad-creator-date-input"
                />
              </div>

              <div className="notepad-creator-footer">
                <div className="notepad-creator-toolbar">
                  <button
                    type="button"
                    onClick={handlePasteToCreator}
                    className="btn-creator-action"
                    title="Paste Clipboard Content"
                  >
                    <Clipboard size={16} />
                  </button>
                </div>

                <div className="notepad-creator-buttons">
                  <button
                    type="button"
                    onClick={handleCreateNoteSubmit}
                    className="btn-creator-save"
                    disabled={!creatorText.trim() && !creatorTitle.trim()}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreatorTitle('');
                      setCreatorText('');
                      setCreatorPinned(false);
                      setIsCreatorExpanded(false);
                    }}
                    className="btn-creator-close"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Note Grid Sections */}
      {filteredNotes.length === 0 ? (
        <div className="notepad-empty-state">
          <AlertCircle size={32} className="empty-icon" />
          <p className="empty-title">No notes found</p>
          <p>
            {searchQuery.trim() 
              ? 'Try adjusting your search query.' 
              : 'Create a manual note or paste from clipboard above to begin.'}
          </p>
        </div>
      ) : (
        <>
          {/* PINNED NOTES SECTION */}
          {pinnedNotes.length > 0 && (
            <div className="notepad-grid-section">
              <span className="notepad-grid-section-title">Pinned</span>
              <div className="notepad-grid">
                {pinnedNotes.map(note => (
                  <div
                    key={note.id}
                    className="notepad-entry-card pinned"
                    onClick={() => handleOpenEditModal(note)}
                  >
                    <div className="entry-header">
                      <h4 className="entry-title">{note.title || 'Untitled Note'}</h4>
                      <button
                        type="button"
                        onClick={(e) => handleCardTogglePin(e, note)}
                        className="btn-card-pin active-pin"
                        title="Unpin Note"
                      >
                        <Pin size={14} fill="currentColor" />
                      </button>
                    </div>
                    
                    <p className="entry-content">{note.content}</p>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="entry-date-badge">
                        {formatCardDate(note.date)} at {note.time}
                      </span>
                    </div>

                    <div className="entry-hover-actions">
                      <button
                        type="button"
                        onClick={(e) => handleCardCopy(e, note.content)}
                        className="btn-entry-action"
                        title="Copy to Clipboard"
                      >
                        <Copy size={14} />
                      </button>

                      <button
                        type="button"
                        onClick={(e) => handleCardDelete(e, note)}
                        className="btn-entry-action hover-danger"
                        title="Delete Note"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* OTHERS / UNPINNED SECTION */}
          {otherNotes.length > 0 && (
            <div className="notepad-grid-section">
              {pinnedNotes.length > 0 && <span className="notepad-grid-section-title">Others</span>}
              <div className="notepad-grid">
                {otherNotes.map(note => (
                  <div
                    key={note.id}
                    className="notepad-entry-card"
                    onClick={() => handleOpenEditModal(note)}
                  >
                    <div className="entry-header">
                      <h4 className="entry-title">{note.title || 'Untitled Note'}</h4>
                      <button
                        type="button"
                        onClick={(e) => handleCardTogglePin(e, note)}
                        className="btn-card-pin"
                        title="Pin Note"
                      >
                        <Pin size={14} />
                      </button>
                    </div>
                    
                    <p className="entry-content">{note.content}</p>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span className="entry-date-badge">
                        {formatCardDate(note.date)} at {note.time}
                      </span>
                    </div>

                    <div className="entry-hover-actions">
                      <button
                        type="button"
                        onClick={(e) => handleCardCopy(e, note.content)}
                        className="btn-entry-action"
                        title="Copy to Clipboard"
                      >
                        <Copy size={14} />
                      </button>

                      <button
                        type="button"
                        onClick={(e) => handleCardDelete(e, note)}
                        className="btn-entry-action hover-danger"
                        title="Delete Note"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Edit Note Modal */}
      {editingNote && (
        <div className="notepad-modal-overlay" onClick={handleSaveEdit}>
          <div 
            className="notepad-modal-card" 
            onClick={(e) => e.stopPropagation()}
          >
            <div className="notepad-modal-header">
              <input
                type="text"
                placeholder="Title"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                className="notepad-modal-title-input"
              />
              <button
                type="button"
                onClick={() => setEditingPinned(prev => !prev)}
                className={`btn-creator-action ${editingPinned ? 'btn-card-pin active-pin' : ''}`}
                title={editingPinned ? "Unpin Note" : "Pin Note"}
              >
                <Pin size={16} fill={editingPinned ? "currentColor" : "none"} />
              </button>
            </div>

            <textarea
              placeholder="Note"
              value={editingText}
              onChange={(e) => setEditingText(e.target.value)}
              className="notepad-modal-textarea"
              rows={6}
            />

            <div className="notepad-modal-date-picker">
              <span>Date Associated:</span>
              <input
                type="date"
                value={editingNoteDate}
                onChange={(e) => setEditingNoteDate(e.target.value)}
                className="notepad-creator-date-input"
              />
            </div>

            <div className="notepad-modal-footer" style={{ justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={handleSaveEdit}
                className="btn-creator-save"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
