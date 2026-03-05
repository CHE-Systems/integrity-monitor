import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export function ProfileMenu() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [isOpen]);

  const handleSignOut = async () => {
    try {
      await signOut();
      setIsOpen(false);
    } catch (error) {
      console.error("Sign out failed:", error);
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      {/* Profile Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--brand)] text-white hover:bg-[var(--brand)]/90 transition-colors overflow-hidden"
        aria-label="Profile menu"
      >
        {user?.photoURL ? (
          <img
            src={user.photoURL}
            alt="Profile"
            referrerPolicy="no-referrer"
            className="h-9 w-9 rounded-full object-cover"
          />
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="w-5 h-5"
          >
            <path
              fillRule="evenodd"
              d="M7.5 6a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM3.751 20.105a8.25 8.25 0 0116.498 0 .75.75 0 01-.437.695A18.683 18.683 0 0112 22.5c-2.786 0-5.433-.608-7.812-1.7a.75.75 0 01-.437-.695z"
              clipRule="evenodd"
            />
          </svg>
        )}
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-64 rounded-2xl border border-[var(--border)] bg-white shadow-lg overflow-hidden z-50">
          {/* User Info Section */}
          <div className="px-4 py-3 border-b border-[var(--border)]">
            <p className="text-sm font-medium text-[var(--text-main)]">
              Signed in as
            </p>
            <p className="text-sm text-[var(--text-muted)] truncate">
              {user?.email || "No email"}
            </p>
          </div>

          {/* Menu Items */}
          <div className="p-2 border-b border-[var(--border)]">
            <button
              onClick={() => {
                navigate("/api-keys");
                setIsOpen(false);
              }}
              className="w-full rounded-xl px-4 py-2 text-left text-sm font-medium text-[var(--text-main)] hover:bg-gray-100 transition-colors"
            >
              API Keys
            </button>
            <button
              onClick={() => {
                navigate("/schema");
                setIsOpen(false);
              }}
              className="w-full rounded-xl px-4 py-2 text-left text-sm font-medium text-[var(--text-main)] hover:bg-gray-100 transition-colors"
            >
              Schema
            </button>
          </div>

          {/* Sign Out Button */}
          <div className="p-2">
            <button
              onClick={handleSignOut}
              className="w-full rounded-xl px-4 py-2 text-left text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
