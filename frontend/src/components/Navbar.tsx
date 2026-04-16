import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { Film, Search, User, LogOut, BarChart3, Menu, X } from 'lucide-react';
import { useState } from 'react';

export function Navbar() {
  const { user, logout, isAuthenticated } = useAuthStore();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const authed = isAuthenticated();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <nav className="sticky top-0 z-50 border-b border-[hsl(var(--border))] bg-[hsl(var(--background))]/95 backdrop-blur">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-xl font-bold text-[hsl(var(--primary))]">
            <Film className="h-6 w-6" />
            CineTrack
          </Link>

          {authed && (
            <div className="hidden md:flex items-center gap-6">
              <Link to="/search" className="flex items-center gap-1 text-sm hover:text-[hsl(var(--primary))] transition-colors">
                <Search className="h-4 w-4" /> Search
              </Link>
              <Link to="/tracking" className="flex items-center gap-1 text-sm hover:text-[hsl(var(--primary))] transition-colors">
                <BarChart3 className="h-4 w-4" /> My List
              </Link>
              <Link to="/stats" className="flex items-center gap-1 text-sm hover:text-[hsl(var(--primary))] transition-colors">
                <BarChart3 className="h-4 w-4" /> Stats
              </Link>
              <Link to={`/profile/${user?.username}`} className="flex items-center gap-1 text-sm hover:text-[hsl(var(--primary))] transition-colors">
                <User className="h-4 w-4" /> {user?.username}
              </Link>
              <button onClick={handleLogout} className="flex items-center gap-1 text-sm text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] transition-colors">
                <LogOut className="h-4 w-4" /> Logout
              </button>
            </div>
          )}

          {!authed && (
            <div className="hidden md:flex items-center gap-4">
              <Link to="/login" className="text-sm hover:text-[hsl(var(--primary))]">Login</Link>
              <Link to="/register" className="rounded-md bg-[hsl(var(--primary))] px-4 py-2 text-sm text-white hover:opacity-90">Register</Link>
            </div>
          )}

          <button className="md:hidden" onClick={() => setMobileOpen(!mobileOpen)}>
            {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
          </button>
        </div>

        {mobileOpen && (
          <div className="md:hidden pb-4 space-y-2">
            {authed ? (
              <>
                <Link to="/search" className="block py-2 text-sm" onClick={() => setMobileOpen(false)}>Search</Link>
                <Link to="/tracking" className="block py-2 text-sm" onClick={() => setMobileOpen(false)}>My List</Link>
                <Link to="/stats" className="block py-2 text-sm" onClick={() => setMobileOpen(false)}>Stats</Link>
                <Link to={`/profile/${user?.username}`} className="block py-2 text-sm" onClick={() => setMobileOpen(false)}>Profile</Link>
                <button onClick={handleLogout} className="block py-2 text-sm text-[hsl(var(--destructive))]">Logout</button>
              </>
            ) : (
              <>
                <Link to="/login" className="block py-2 text-sm" onClick={() => setMobileOpen(false)}>Login</Link>
                <Link to="/register" className="block py-2 text-sm" onClick={() => setMobileOpen(false)}>Register</Link>
              </>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
