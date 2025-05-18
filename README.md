# Job Assignment Chat Application

A real-time chat application with user authentication using Node.js, Express, MySQL, and Socket.io.

## Features

- User registration and login
- Real-time messaging using WebSockets
- Typing indicators
- Session management
- MySQL database for user and message storage

## Technologies Used

- **Frontend**: HTML, CSS, JavaScript
- **Backend**: Node.js, Express.js
- **Database**: MySQL
- **Real-time Communication**: Socket.io
- **Authentication**: bcrypt for password hashing, express-session for session management

## Setup Instructions

### Prerequisites

- Node.js (v14+)
- MySQL Server

### Installation

1. Clone the repository
   ```
   git clone <repository-url>
   cd job_assignment
   ```

2. Install dependencies
   ```
   npm install
   ```

3. Set up the database
   - Create a MySQL database
   - Run the SQL queries in `database.sql` to create the necessary tables

4. Create a `.env` file in the root directory with the following content:
   ```
   PORT=3000
   DB_HOST=localhost
   DB_USER=your_mysql_username
   DB_PASSWORD=your_mysql_password
   DB_NAME=job_assignment
   SESSION_SECRET=your_secret_key
   ```

5. Start the server
   ```
   node index.js
   ```

6. Access the application
   - Open your browser and go to `http://localhost:3000`
   - You should see the login page

## Database Structure

- **users**: Stores user account information
  - id (Primary Key)
  - name
  - email (Unique)
  - password (Hashed)
  - created_at

- **messages**: Stores chat messages
  - id (Primary Key)
  - user_id (Foreign Key referencing users.id)
  - content
  - room_id (Optional for group chats)
  - created_at

- **user_rooms**: Maps users to chat rooms
  - id (Primary Key)
  - user_id (Foreign Key referencing users.id)
  - room_id
  - created_at 