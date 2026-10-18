import queue
import threading
import can
import customtkinter as ctk
from tkinter import messagebox

# Configuration
CHANNEL = 'PCAN_USBBUS1'
BITRATE = 500000

# Set modern appearance
ctk.set_appearance_mode("Dark")  # Modes: "System" (standard), "Dark", "Light"
ctk.set_default_color_theme("blue")  # Themes: "blue" (standard), "green", "dark-blue"

class CamperApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Camper Relay Controller - PCAN")
        self.root.geometry("750x550")
        self.root.minsize(700, 500)

        self.bus = None
        self.is_connected = False
        self.msg_queue = queue.Queue()

        # Internal state
        self.relay_state_mask = 0
        self.input_state_mask = 0
        self.voltages = [0, 0, 0]
        self.can_state_str = "DISCONNECTED"
        self.rx_count = 0
        self.heartbeat_cnt = 0

        self.relay_buttons = []
        self.input_indicators = []
        self.volt_labels = []

        self.create_widgets()
        
        # Start CAN listener thread
        self.running = True
        self.can_thread = threading.Thread(target=self.can_worker, daemon=True)
        self.can_thread.start()

        # Cyclic queue polling in main GUI thread
        self.root.after(50, self.process_queue)

    def create_widgets(self):
        # --- TOP FRAME: Connection ---
        top_frame = ctk.CTkFrame(self.root, corner_radius=10)
        top_frame.pack(fill="x", padx=15, pady=15)

        self.lbl_status = ctk.CTkLabel(top_frame, text="Disconnected", font=ctk.CTkFont(size=14, weight="bold"), text_color="#ff4757")
        self.lbl_status.pack(side="left", padx=15, pady=10)

        self.btn_connect = ctk.CTkButton(top_frame, text="Connect to PCAN", command=self.toggle_connection, fg_color="#2ed573", hover_color="#27ae60", text_color="black")
        self.btn_connect.pack(side="right", padx=15, pady=10)

        self.btn_refresh = ctk.CTkButton(top_frame, text="Refresh Status (0x110)", command=self.send_request_status, state="disabled", fg_color="gray")
        self.btn_refresh.pack(side="right", padx=5, pady=10)

        # --- MAIN SECTION (Two Columns) ---
        main_frame = ctk.CTkFrame(self.root, fg_color="transparent")
        main_frame.pack(fill="both", expand=True, padx=15, pady=5)

        # Left Column: Relays and Inputs
        left_col = ctk.CTkFrame(main_frame, fg_color="transparent")
        left_col.pack(side="left", fill="both", expand=True, padx=(0, 10))

        # Relays (GPA 0-7)
        relay_frame = ctk.CTkFrame(left_col, corner_radius=10)
        relay_frame.pack(fill="x", pady=(0, 15))
        
        lbl_relay_title = ctk.CTkLabel(relay_frame, text="Relay Outputs (GPA 1-8)", font=ctk.CTkFont(size=14, weight="bold"))
        lbl_relay_title.grid(row=0, column=0, columnspan=4, pady=10)

        for i in range(8):
            btn = ctk.CTkButton(relay_frame, text=f"Relay {i+1}\n[OFF]", 
                                command=lambda idx=i: self.toggle_relay_action(idx), 
                                state="disabled", fg_color="#2f3542", hover_color="#57606f", height=50)
            # Grid 2 rows, 4 columns (starting from row 1)
            btn.grid(row=(i//4) + 1, column=i%4, padx=5, pady=5, sticky="nsew")
            self.relay_buttons.append(btn)
        
        for c in range(4):
            relay_frame.columnconfigure(c, weight=1)

        # Digital Inputs (GPB 0-7)
        input_frame = ctk.CTkFrame(left_col, corner_radius=10)
        input_frame.pack(fill="x")

        lbl_input_title = ctk.CTkLabel(input_frame, text="Digital Inputs (GPB 0-7)", font=ctk.CTkFont(size=14, weight="bold"))
        lbl_input_title.grid(row=0, column=0, columnspan=8, pady=10)

        for i in range(8):
            lbl = ctk.CTkLabel(input_frame, text=f"IN {i}\n[LOW]", corner_radius=5, 
                               fg_color="#2f3542", text_color="white", width=45, height=45)
            lbl.grid(row=1, column=i, padx=3, pady=10, sticky="nsew")
            input_frame.columnconfigure(i, weight=1)
            self.input_indicators.append(lbl)

        # Right Column: Voltages and Diagnostics
        right_col = ctk.CTkFrame(main_frame, fg_color="transparent")
        right_col.pack(side="right", fill="both", expand=True)

        # INA3221 Voltages
        volt_frame = ctk.CTkFrame(right_col, corner_radius=10)
        volt_frame.pack(fill="x", pady=(0, 15))

        lbl_volt_title = ctk.CTkLabel(volt_frame, text="Voltage Measurements (INA3221)", font=ctk.CTkFont(size=14, weight="bold"))
        lbl_volt_title.pack(anchor="w", padx=15, pady=(10, 5))

        for i in range(3):
            lbl = ctk.CTkLabel(volt_frame, text=f"Channel {i+1}: --.--- V", font=ctk.CTkFont(family="Consolas", size=13))
            lbl.pack(anchor="w", padx=20, pady=5)
            self.volt_labels.append(lbl)
        
        # Add a little bottom padding to volt_frame
        ctk.CTkLabel(volt_frame, text="").pack(pady=2) 

        # Bus Diagnostics / Heartbeat
        diag_frame = ctk.CTkFrame(right_col, corner_radius=10)
        diag_frame.pack(fill="x")

        lbl_diag_title = ctk.CTkLabel(diag_frame, text="Bus Diagnostics", font=ctk.CTkFont(size=14, weight="bold"))
        lbl_diag_title.pack(anchor="w", padx=15, pady=(10, 5))

        self.lbl_can_state = ctk.CTkLabel(diag_frame, text="CAN State: --", font=ctk.CTkFont(size=12))
        self.lbl_can_state.pack(anchor="w", padx=20, pady=2)
        
        self.lbl_rx_count = ctk.CTkLabel(diag_frame, text="Received frames: 0", font=ctk.CTkFont(size=12))
        self.lbl_rx_count.pack(anchor="w", padx=20, pady=2)
        
        self.lbl_heartbeat = ctk.CTkLabel(diag_frame, text="Heartbeat: None (cnt: 0)", font=ctk.CTkFont(size=12))
        self.lbl_heartbeat.pack(anchor="w", padx=20, pady=(2, 15))

    def toggle_connection(self):
        if not self.is_connected:
            try:
                self.bus = can.Bus(interface='pcan', channel=CHANNEL, bitrate=BITRATE)
                self.is_connected = True
                self.lbl_status.configure(text="Connected (PCAN-USB)", text_color="#2ed573")
                self.btn_connect.configure(text="Disconnect", fg_color="#ff4757", hover_color="#ff6b81", text_color="white")
                self.btn_refresh.configure(state="normal", fg_color="#1e90ff")
                for btn in self.relay_buttons:
                    btn.configure(state="normal")
                self.send_request_status()
            except Exception as e:
                messagebox.showerror("Connection Error", f"Failed to connect to PCAN:\n{e}")
        else:
            self.disconnect_can()

    def disconnect_can(self):
        if self.bus:
            try:
                self.bus.shutdown()
            except:
                pass
            self.bus = None
            
        self.is_connected = False
        self.lbl_status.configure(text="Disconnected", text_color="#ff4757")
        self.btn_connect.configure(text="Connect to PCAN", fg_color="#2ed573", hover_color="#27ae60", text_color="black")
        self.btn_refresh.configure(state="disabled", fg_color="gray")
        
        for btn in self.relay_buttons:
            btn.configure(state="disabled", text=f"Relay\n[OFF]", fg_color="#2f3542")
            
        for lbl in self.input_indicators:
            lbl.configure(text=f"IN\n[LOW]", fg_color="#2f3542")

    def can_worker(self):
        while self.running:
            if self.bus and self.is_connected:
                try:
                    msg = self.bus.recv(timeout=0.1)
                    if msg:
                        self.msg_queue.put(msg)
                except Exception:
                    pass
            else:
                threading.Event().wait(0.1)

    def process_queue(self):
        try:
            while True:
                msg = self.msg_queue.get_nowait()
                self.handle_can_message(msg)
        except queue.Empty:
            pass
        
        self.root.after(50, self.process_queue)

    def handle_can_message(self, msg):
        if msg.is_extended_id:
            return

        can_id = msg.arbitration_id
        data = msg.data

        if can_id == 0x180:  # I/O Status
            if len(data) >= 2:
                self.relay_state_mask = data[0]
                self.input_state_mask = data[1]
                self.rx_count += 1
                self.update_ui_states()

        elif can_id == 0x181:  # INA3221 Voltages
            if len(data) >= 6:
                self.voltages[0] = data[0] | (data[1] << 8)
                self.voltages[1] = data[2] | (data[3] << 8)
                self.voltages[2] = data[4] | (data[5] << 8)
                self.rx_count += 1
                self.update_ui_voltages()

        elif can_id == 0x190:  # Heartbeat
            if len(data) >= 4:
                self.heartbeat_cnt = data[0]
                state_code = data[1]
                states = {0: "ACTIVE", 1: "WARN", 2: "PASSIVE", 3: "BUS-OFF"}
                self.can_state_str = states.get(state_code, "UNKNOWN")
                self.relay_state_mask = data[2]
                self.input_state_mask = data[3]
                self.rx_count += 1
                self.update_ui_states()
                self.update_ui_heartbeat()

    def update_ui_states(self):
        for i in range(8):
            is_on = (self.relay_state_mask & (1 << i)) != 0
            if is_on:
                self.relay_buttons[i].configure(text=f"Relay {i+1}\n[ON]", fg_color="#ff4757", hover_color="#ff6b81")
            else:
                self.relay_buttons[i].configure(text=f"Relay {i+1}\n[OFF]", fg_color="#1e90ff", hover_color="#3742fa")

        for i in range(8):
            is_high = (self.input_state_mask & (1 << i)) != 0
            lbl = self.input_indicators[i]
            if is_high:
                lbl.configure(text=f"IN {i}\n[HIGH]", fg_color="#2ed573", text_color="black")
            else:
                lbl.configure(text=f"IN {i}\n[LOW]", fg_color="#2f3542", text_color="white")

        self.lbl_rx_count.configure(text=f"Received frames: {self.rx_count}")
        self.lbl_can_state.configure(text=f"CAN State: {self.can_state_str}")

    def update_ui_voltages(self):
        for i in range(3):
            mv = self.voltages[i]
            self.volt_labels[i].configure(text=f"Channel {i+1}: {mv/1000:.3f} V ({mv} mV)")

    def update_ui_heartbeat(self):
        self.lbl_heartbeat.configure(text=f"Heartbeat: OK (cnt: {self.heartbeat_cnt})")

    def toggle_relay_action(self, relay_idx):
        if not self.is_connected or not self.bus:
            return
        
        relay_num = relay_idx + 1
        action = 2  # Toggle
        
        msg = can.Message(
            arbitration_id=0x101,
            data=[relay_num, action],
            is_extended_id=False
        )
        try:
            self.bus.send(msg)
        except Exception as e:
            messagebox.showerror("Send Error", f"Failed to send CAN frame:\n{e}")

    def send_request_status(self):
        if not self.is_connected or not self.bus:
            return
        msg = can.Message(
            arbitration_id=0x110,
            data=[],
            is_extended_id=False
        )
        try:
            self.bus.send(msg)
        except Exception as e:
            messagebox.showerror("Error", f"Failed to send request:\n{e}")

    def on_closing(self):
        self.running = False
        self.disconnect_can()
        self.root.destroy()

if __name__ == "__main__":
    root = ctk.CTk()
    app = CamperApp(root)
    root.protocol("WM_DELETE_WINDOW", app.on_closing)
    root.mainloop()