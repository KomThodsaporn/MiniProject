document.addEventListener('DOMContentLoaded', () => {
    const songTableBody = document.getElementById('song-stats-body');
    const artistTableBody = document.getElementById('artist-stats-body');

    async function fetchStats() {
        try {
            const response = await fetch('/api/stats');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const stats = await response.json();
            
            populateTable(songTableBody, stats.songs);
            populateTable(artistTableBody, stats.artists);

        } catch (error) {
            console.error("Failed to fetch stats:", error);
            songTableBody.innerHTML = '<tr><td colspan="3">Error loading stats.</td></tr>';
            artistTableBody.innerHTML = '<tr><td colspan="3">Error loading stats.</td></tr>';
        }
    }

    function populateTable(tbody, data) {
        tbody.innerHTML = ''; // Clear existing data

        if (!data || data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3">No data available.</td></tr>';
            return;
        }

        data.forEach((item, index) => {
            const row = document.createElement('tr');
            
            const rankCell = document.createElement('td');
            rankCell.textContent = index + 1;
            
            const nameCell = document.createElement('td');
            nameCell.textContent = item.name;
            
            const countCell = document.createElement('td');
            countCell.textContent = item.count;
            
            row.appendChild(rankCell);
            row.appendChild(nameCell);
            row.appendChild(countCell);
            
            tbody.appendChild(row);
        });
    }

    fetchStats();
});
