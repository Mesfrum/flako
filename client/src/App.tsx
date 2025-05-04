import {
  Link,
  Route,
  RouterProvider,
  createBrowserRouter,
  createRoutesFromElements,
  Outlet,
} from "react-router-dom";

function Layout() {
  return (
    <div>
      <nav className="p-4 bg-gray-100 text-center space-x-4">
        <Link className="text-blue-500 hover:underline" to="/">
          Home
        </Link>
        <Link className="text-green-500 hover:underline" to="/about">
          About
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}

function Home() {
  return (
    <div className="p-8 text-center">
      <h1 className="text-3xl font-bold text-blue-600">🏠 Home Page</h1>
      <p className="mt-2 text-gray-700">Tailwind CSS is working!</p>
    </div>
  );
}

function About() {
  return (
    <div className="p-8 text-center">
      <h1 className="text-3xl font-bold text-green-600">ℹ️ About Page</h1>
      <p className="mt-2 text-gray-700">This is a sample about route.</p>
    </div>
  );
}

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<Layout />}>
      <Route path="/" element={<Home />} />
      <Route path="/about" element={<About />} />
    </Route>
  )
);

export default function App() {
  return <RouterProvider router={router} />;
}
