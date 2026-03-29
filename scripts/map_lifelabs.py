# pip install folium
import folium
import csv

def map_locations(csv_file="lifelabs_bc.csv", output="lifelabs_map.html"):
    m = folium.Map(location=[53.7, -127.6], zoom_start=6, tiles="OpenStreetMap")

    count = 0
    with open(csv_file, newline="") as f:
        for row in csv.DictReader(f):
            try:
                lat, lng = float(row["lat"]), float(row["lng"])
            except (ValueError, KeyError):
                continue  # skip rows without coords

            folium.Marker(
                location=[lat, lng],
                popup=folium.Popup(
                    f"<b>{row.get('name','')}</b><br>{row.get('address','')}<br>{row.get('city','')}<br>{row.get('phone','')}",
                    max_width=200
                ),
                tooltip=row.get("name", "LifeLabs"),
                icon=folium.Icon(color="red", icon="plus-sign")
            ).add_to(m)
            count += 1

    m.save(output)
    print(f"✅ Map saved → {output} ({count} locations)")
    print("👉 Open it in any browser")

if __name__ == "__main__":
    map_locations()
