import { useNavigate } from "react-router-dom";

export default function Home() {
  const navigate = useNavigate();

  const createNewNote = () => {
    navigate(`/note/${"taco"}`);
  };

  return (
    <div className="min-h-screen font-serif bg-gradient-to-br from-white to-gray-100 flex items-center justify-center px-4">
      <div className="max-w-xl text-center">
        <h1 className="text-5xl font-extrabold text-gray-900 mb-6 tracking-tight leading-tight">
          Welcome to <span className="text-blue-600">Shrib Clone</span>
        </h1>
        <p className="text-gray-600 text-lg mb-8">
          A minimalist note-taking app. Create and access notes instantly.
        </p>
        <button
          onClick={createNewNote}
          className="bg-blue-600 hover:bg-blue-700 text-white text-lg font-medium px-6 py-3 rounded-lg shadow-md transition-all duration-200"
        >
          Create New Note
        </button>
      </div>
    </div>
  );
}
