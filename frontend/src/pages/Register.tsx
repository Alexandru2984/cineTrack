import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useRegister } from '@/hooks/useAuth';
import { Film, Loader2 } from 'lucide-react';

export default function RegisterPage() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const register = useRegister();
  const navigate = useNavigate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    register.mutate({ username, email, password }, {
      onSuccess: () => navigate('/'),
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <Film className="mx-auto h-12 w-12 text-[hsl(var(--primary))]" />
          <h1 className="mt-4 text-3xl font-bold">Create account</h1>
          <p className="mt-2 text-[hsl(var(--muted-foreground))]">Start tracking your movies & shows</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              maxLength={50}
              className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
              placeholder="cinephile42"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded-md border border-[hsl(var(--input))] bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
              placeholder="Min 8 characters"
            />
          </div>

          {register.error && (
            <p className="text-sm text-[hsl(var(--destructive))]">
              {(register.error as any)?.response?.data?.message || 'Registration failed'}
            </p>
          )}

          <button
            type="submit"
            disabled={register.isPending}
            className="w-full rounded-md bg-[hsl(var(--primary))] py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {register.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Create account
          </button>
        </form>

        <p className="text-center text-sm text-[hsl(var(--muted-foreground))]">
          Already have an account?{' '}
          <Link to="/login" className="text-[hsl(var(--primary))] hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
