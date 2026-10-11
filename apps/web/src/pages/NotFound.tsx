import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="py-20 text-center">
      <div className="text-4xl font-bold">404</div>
      <p className="mt-2 text-muted">This page does not exist.</p>
      <Link to="/tools" className="btn-primary mt-4">
        Browse all tools
      </Link>
    </div>
  );
}
